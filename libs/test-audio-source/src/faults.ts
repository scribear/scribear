import { applyDcOffset, digitalSilence, hardClipToRail } from './effects.js';
import type { FaultParams } from './params.js';
import type { Rng } from './rng.js';
import { type AudioChunk, decodeWav, encodeWav } from './wav.js';

/**
 * The fault engine: turns one source chunk plus a parameter set into a plan for
 * what to put on the wire.
 *
 * Planning is separated from sending on purpose. Every knob's effect is then a
 * pure function of `(chunk, params, rng)` and can be asserted exactly — "with
 * this seed, frames 3 and 7 are dropped" — instead of statistically. The
 * streamer that consumes a plan contains no policy at all.
 */

/**
 * Sample rate written into a `badHeaderPct` frame's WAV header.
 *
 * 8000 rather than a nonsense value because the fault being reproduced is a
 * *plausible* misconfiguration — a source device left at telephone rate — and
 * because it must still be a header `soundfile` will open. The transcription
 * service's `AudioDecoder` compares the container's rate against the rate the
 * provider expects and raises `Sample rate mismatch: ...` on any disagreement,
 * so the value only has to differ, not be absurd.
 */
export const BAD_HEADER_SAMPLE_RATE = 8_000;

/** One frame the streamer should emit, and how it should be damaged. */
export interface PlannedFrame {
  /** The complete WAV file to carry as the SAFP payload. */
  wav: Buffer;
  /**
   * Reuse the previous frame's `chunkId` rather than minting a new one. Set
   * only on the second copy of a stuttered chunk — the duplicate id is the
   * observable, not the repeated audio.
   */
  reuseChunkId: boolean;
  /** Corrupt the encoded SAFP envelope so its CRC no longer matches. */
  corrupt: boolean;
  /** Milliseconds to add to the `sentAt` this frame declares. */
  sentAtSkewMs: number;
}

/** What to do with one source chunk. */
export interface ChunkPlan {
  /** Zero frames (dropped), one (normal) or two (stuttered). */
  frames: PlannedFrame[];
  /**
   * Wall-clock milliseconds to wait before planning the next chunk.
   *
   * Always the audio duration this chunk accounts for, divided by `speedup` —
   * including for a dropped chunk, whose silence is the fault, and for a
   * stuttered one, which accounts for two chunks' worth of audio because it
   * puts two chunks' worth on the wire.
   */
  waitMs: number;
  /**
   * True when a knob altered this chunk's frames — their audio, their framing
   * or their metadata.
   *
   * Deliberately not set by `speedup` alone. That knob changes when frames are
   * sent and nothing about the frames themselves, and counting its runs as
   * "faulted frames" would make the counter agree with neither its name nor
   * what an operator can see on the wire.
   */
  faulted: boolean;
}

/**
 * What the streamer needs from a device's engine.
 *
 * Both devices implement it, so pacing, framing, `chunkId` minting, clock sync
 * and reconnection exist once rather than twice. Everything that differs
 * between a `good` device and a `fault` device is a difference in the plans it
 * returns.
 */
export interface ChunkPlanner {
  plan(chunk: AudioChunk): ChunkPlan;
  /** Consulted only for a frame the plan marked `corrupt`. */
  corruptFrame(frame: Uint8Array): Uint8Array;
}

/**
 * Applies the fault knobs to a stream of source chunks.
 *
 * Holds no audio of its own and no connection: it is handed a chunk and returns
 * a plan. `params` is replaced wholesale by {@link setParams} when an operator
 * retunes a running device, which is why nothing here caches a derived value.
 */
export class FaultEngine implements ChunkPlanner {
  private _params: FaultParams;
  private _rng: Rng;

  constructor(params: FaultParams, rng: Rng) {
    this._params = params;
    this._rng = rng;
  }

  get params(): FaultParams {
    return this._params;
  }

  /** Retunes a running engine. Takes effect on the next chunk planned. */
  setParams(params: FaultParams): void {
    this._params = params;
  }

  /**
   * Plans one chunk.
   *
   * Order of the audio faults is fixed and load-bearing: silence replaces
   * everything (there is nothing left to clip), clipping runs before the DC
   * bias so the bias is not amplified by the clipper's gain (see
   * {@link applyDcOffset} for why the two knobs cannot both be exact), and the
   * header rewrite happens last because it is a container change rather than a
   * waveform one.
   */
  plan(chunk: AudioChunk): ChunkPlan {
    const params = this._params;
    const waitMs = sendIntervalMs(chunk.durationMs, params.speedup);

    if (this._draw(params.dropPct)) {
      // The gap is the fault: the schedule still advances, so the next chunk
      // goes out at the time it would have, leaving a real hole in the audio
      // rather than a seam.
      return { frames: [], waitMs, faulted: true };
    }

    const silence = this._draw(params.silencePct);
    const badHeader = this._draw(params.badHeaderPct);
    const wav = this._buildWav(chunk, silence, badHeader);

    const first: PlannedFrame = {
      wav,
      reuseChunkId: false,
      corrupt: this._draw(params.corruptPct),
      sentAtSkewMs: params.clockSkewMs,
    };
    const frames = [first];

    let stuttered = false;
    if (this._draw(params.stutterPct)) {
      stuttered = true;
      frames.push({
        wav,
        reuseChunkId: true,
        // Drawn independently: a stutter and a corruption are separate faults
        // and stacking them must not be more or less likely than either alone.
        corrupt: this._draw(params.corruptPct),
        sentAtSkewMs: params.clockSkewMs,
      });
    }

    const faulted =
      silence ||
      badHeader ||
      stuttered ||
      first.corrupt ||
      frames[1]?.corrupt === true ||
      params.clipPct > 0 ||
      params.dcOffset > 0 ||
      params.clockSkewMs !== 0;

    return {
      frames,
      // A stutter puts two chunks of audio on the wire, so it must buy two
      // chunks of time. Not doing so would make every stutter *also* a
      // faster-than-realtime burst, and `speedup` would stop being the only
      // knob that trips the too-fast path.
      waitMs: stuttered ? waitMs * 2 : waitMs,
      faulted,
    };
  }

  /**
   * Corrupts an encoded SAFP frame so `decodeAudioFrame` rejects it.
   *
   * Flips a single bit inside the envelope, leaving the trailing CRC-32 stale.
   * CRC-32 detects every single-bit error, so this fails **deterministically**
   * — which a truncation does not: lopping off the checksum leaves the last
   * four payload bytes to be read as one, and those match by accident often
   * enough that a test could not assert on it. Both damages surface as the same
   * thing downstream, a `safp_decode_drops_total` increment and the U2/S4
   * decode-drop warning, so the reliable one is the one worth sending.
   */
  corruptFrame(frame: Uint8Array): Uint8Array {
    const out = Uint8Array.from(frame);
    // Confined to the body: the magic and version live in the first four bytes
    // and damaging those produces "not a SAFP frame" rather than the CRC
    // failure the decode-drop counter is fed by.
    const start = Math.min(4, out.length);
    const end = Math.max(start, out.length - 4);
    if (end <= start) return out;

    const index = start + Math.floor(this._rng() * (end - start));
    const bit = 1 << Math.floor(this._rng() * 8);
    out[index] = (out[index] ?? 0) ^ bit;
    return out;
  }

  /** Builds the frame's WAV payload, applying the waveform faults. */
  private _buildWav(
    chunk: AudioChunk,
    silence: boolean,
    badHeader: boolean,
  ): Buffer {
    const decoded = decodeWav(chunk.wav);
    let pcm = decoded.pcm;

    if (silence) {
      pcm = digitalSilence(pcm.length);
    } else {
      pcm = hardClipToRail(pcm, this._params.clipPct);
      pcm = applyDcOffset(pcm, this._params.dcOffset);
    }

    // Re-encoded unconditionally rather than only when something changed: the
    // header must be rewritten anyway for `badHeaderPct`, and re-encoding
    // unchanged PCM is byte-identical to the input, so the branch would buy
    // nothing but a way to get the two paths out of step.
    return encodeWav(
      pcm,
      badHeader ? BAD_HEADER_SAMPLE_RATE : decoded.sampleRate,
      decoded.channels,
    );
  }

  /**
   * One draw against a percentage knob.
   *
   * 0 never fires and 100 always fires, exactly, rather than as the limit of a
   * comparison: `rng() < 0` is already never true, but `rng() < 1` is *almost*
   * always true, and "almost" is not what a knob at 100 promises.
   */
  private _draw(percent: number): boolean {
    if (percent <= 0) return false;
    if (percent >= 100) return true;
    return this._rng() * 100 < percent;
  }
}

/**
 * Wall-clock interval between sends for a chunk of `chunkDurationMs` audio.
 *
 * The entire implementation of `speedup`, and deliberately the only place it
 * appears: the knob exists to trip the transcription service's
 * faster-than-realtime rejection (`Client sent audio too quickly.`, WebSocket
 * close 1007), and it can only do that cleanly if the audio itself is
 * byte-identical to what a speedup of 1 would have sent.
 */
export function sendIntervalMs(
  chunkDurationMs: number,
  speedup: number,
): number {
  return chunkDurationMs / (speedup > 0 ? speedup : 1);
}
