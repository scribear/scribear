import { readFile } from 'node:fs/promises';

import { decodeWav, encodeWav } from '@scribear/test-audio-source';

/**
 * Builds the `longform` clip PLAN-TestAudioDevices §2.1 names.
 *
 * **Why it is built rather than committed.** Five minutes of 16 kHz mono 16-bit
 * WAV is ~9.6 MB. That does not belong in git, and it does not need to: it is
 * derived audio with no reference transcript and nothing scores against it.
 *
 * **Why it exists at all.** The two committed fixtures are 33.6 s and 50 s.
 * Whisper's decoder is conditioned on its own recent output, so a loop that
 * short walks the same sentences past the model every half minute — captions
 * start to rhyme with themselves, and an operator watching for repetition
 * cannot tell the model's failure mode from the fixture's. Five minutes is long
 * enough that a run of any realistic duration sees mostly unheard speech.
 *
 * Two sources, in order:
 *
 * 1. A public-domain recording downloaded from `sourceUrl`, when one is
 *    configured and reachable.
 * 2. Otherwise the two committed fixtures, concatenated in a varied order.
 *
 * The result says which of the two it is, and the caller logs it: an operator
 * comparing captions between deployments needs to know whether they are
 * listening to the same audio.
 */

/** Silence inserted between concatenated segments, in milliseconds. */
const SEGMENT_GAP_MS = 250;

/**
 * The source the image build downloads, unless a deployment names another.
 *
 * "Some Mistakes About Economics" (1896), read by Brian Salmons for the Ralat
 * Readings collection on archive.org. Marked **Public Domain Mark 1.0**, with
 * the item description stating that both the recording and the text read are in
 * the public domain.
 *
 * Chosen over the LibriVox items PLAN-TestAudioDevices §2.1 suggested for one
 * disqualifying reason: LibriVox publishes MP3 and Ogg only — a search of the
 * whole `librivoxaudio` collection for WAVE derivatives returns a single jingle
 * — and there is no MP3 decoder here, nor should there be one just for this.
 * This item is already exactly what is needed and needs no conversion:
 * uncompressed 16-bit PCM, mono, 16 kHz, 7 minutes 11 seconds, one speaker,
 * continuous prose measured between -18.6 and -22.6 dBFS throughout.
 *
 * Prose rather than the verse items in the same collection: line-broken poetry
 * gives a transcript full of short fragments, which reads as a segmentation
 * fault in the pipeline rather than as the fixture doing what it was asked to.
 *
 * Note the item's `data` chunk header overcounts by exactly 44 bytes — the
 * encoder wrote the file size into the data-size field. `decodeWav` clamps the
 * chunk to the bytes actually present, so this parses correctly; a reader that
 * trusted the declared size would read past the end.
 */
export const DEFAULT_LONGFORM_URL =
  'https://archive.org/download/RalatEconomicsMistakes/RalatEconomicsMistakes.wav';

export interface LongformOptions {
  /**
   * A public-domain 16 kHz mono 16-bit PCM WAV, at least `targetSec` long.
   *
   * Defaults to {@link DEFAULT_LONGFORM_URL}. Empty skips straight to the
   * fixtures, which is the right setting for a build host with no egress. See
   * {@link fetchLongformSource} for why the format requirements are strict.
   */
  sourceUrl: string;
  /** Committed fixtures to concatenate when the download is unavailable. */
  fallbackPaths: readonly string[];
  targetSec: number;
  /** Both the required source format and the format written out. */
  sampleRate: number;
  channels: number;
  /** Bound on the download. A build must not hang on a dead mirror. */
  timeoutMs: number;
}

export interface LongformResult {
  /** A complete WAV file, `targetSec` long. */
  wav: Buffer;
  source: 'download' | 'fixtures';
  /** One line an operator can read: where the audio came from, or why not. */
  note: string;
}

export class LongformBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LongformBuildError';
  }
}

/**
 * Downloads and validates the configured source.
 *
 * The format requirements are deliberately exact — 16 kHz, mono, 16-bit
 * uncompressed PCM — rather than "whatever it is, convert it". There is no
 * decoder here for MP3 or Ogg, which is what most archive.org items actually
 * offer, and resampling is *not* implemented on purpose: decimating 48 kHz to
 * 16 kHz without an anti-alias filter folds everything above 8 kHz back into
 * the speech band, and a clip whose entire job is to be clean reference speech
 * is the last place to put aliasing. A source that does not already match is
 * rejected with its actual format in the message, and the fixtures are used.
 *
 * @throws {LongformBuildError} on any failure; the caller falls back.
 */
async function fetchLongformSource(options: LongformOptions): Promise<Buffer> {
  let response: Response;
  try {
    response = await fetch(options.sourceUrl, {
      signal: AbortSignal.timeout(options.timeoutMs),
    });
  } catch (err) {
    throw new LongformBuildError(
      `could not fetch ${options.sourceUrl}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!response.ok) {
    throw new LongformBuildError(
      `${options.sourceUrl} answered HTTP ${String(response.status)}`,
    );
  }

  const raw = Buffer.from(await response.arrayBuffer());
  const decoded = decodeWav(raw);

  if (
    decoded.sampleRate !== options.sampleRate ||
    decoded.channels !== options.channels
  ) {
    throw new LongformBuildError(
      `${options.sourceUrl} is ${String(decoded.sampleRate)} Hz / ${String(decoded.channels)} ch, but the clip must be ${String(options.sampleRate)} Hz / ${String(options.channels)} ch and no resampler is shipped`,
    );
  }
  if (decoded.durationMs < options.targetSec * 1000) {
    throw new LongformBuildError(
      `${options.sourceUrl} is only ${(decoded.durationMs / 1000).toFixed(1)}s, short of the ${String(options.targetSec)}s target`,
    );
  }

  return decoded.pcm;
}

/**
 * The order the fixtures are concatenated in: the Thue-Morse sequence.
 *
 * "A varied order" needs to mean something checkable. Alternating strictly
 * (`h a h a`) reintroduces the problem this clip exists to solve one level up —
 * the model then sees a 84-second repeating cycle instead of a 34-second one.
 * Thue-Morse is *overlap-free*: no block of segments occurs three times in a
 * row anywhere in it, at any scale. With two fixtures that is the strongest
 * "not repetitive" property available from a deterministic sequence, and being
 * deterministic matters — two deployments that fall back must build byte-
 * identical audio or captions cannot be compared between them.
 */
function thueMorse(length: number): number[] {
  const out: number[] = [];
  for (let n = 0; n < length; n++) {
    // Parity of the population count of n.
    let bits = 0;
    for (let v = n; v > 0; v >>= 1) bits ^= v & 1;
    out.push(bits);
  }
  return out;
}

/** Concatenates the committed fixtures until the target length is reached. */
async function buildFromFixtures(options: LongformOptions): Promise<Buffer> {
  if (options.fallbackPaths.length === 0) {
    throw new LongformBuildError('no fallback fixtures are configured');
  }

  const segments: Buffer[] = [];
  for (const path of options.fallbackPaths) {
    const decoded = decodeWav(await readFile(path));
    if (
      decoded.sampleRate !== options.sampleRate ||
      decoded.channels !== options.channels
    ) {
      throw new LongformBuildError(
        `fixture ${path} is ${String(decoded.sampleRate)} Hz / ${String(decoded.channels)} ch, not ${String(options.sampleRate)} Hz / ${String(options.channels)} ch`,
      );
    }
    segments.push(decoded.pcm);
  }

  const bytesPerSecond = options.sampleRate * options.channels * 2;
  const targetBytes = options.targetSec * bytesPerSecond;
  // A short silence rather than a butt join. A hard cut between two unrelated
  // recordings is a step discontinuity — a click, which the meter reads as a
  // transient and the model may hear as a plosive. It also gives VAD a real
  // boundary, so the segments are separated in the transcript rather than run
  // together into one sentence that never existed.
  const gap = Buffer.alloc(
    Math.round((SEGMENT_GAP_MS / 1000) * bytesPerSecond) & ~1,
  );

  const parts: Buffer[] = [];
  let bytes = 0;
  // Bounded rather than `while (bytes < targetBytes)`: an empty fixture would
  // otherwise spin forever, and this runs unattended in a container build.
  const order = thueMorse(1024);
  for (const pick of order) {
    if (bytes >= targetBytes) break;
    const segment = segments[pick % segments.length];
    if (segment === undefined || segment.length === 0) continue;
    parts.push(segment, gap);
    bytes += segment.length + gap.length;
  }

  if (bytes < targetBytes) {
    throw new LongformBuildError(
      `fixtures total ${(bytes / bytesPerSecond).toFixed(1)}s, short of the ${String(options.targetSec)}s target`,
    );
  }
  return Buffer.concat(parts).subarray(0, targetBytes);
}

/**
 * Builds the clip, preferring the download and falling back to the fixtures.
 *
 * Never throws for a failed download: an unreachable mirror, a moved file or a
 * build machine with no network must not fail the image build, and the fixtures
 * always produce a serviceable clip. It *does* throw if the fixtures are
 * unusable too, because at that point there is nothing to ship.
 */
export async function buildLongformWav(
  options: LongformOptions,
): Promise<LongformResult> {
  let downloadNote = 'TEST_AUDIO_LONGFORM_URL is empty';

  if (options.sourceUrl !== '') {
    try {
      const pcm = await fetchLongformSource(options);
      const targetBytes =
        options.targetSec * options.sampleRate * options.channels * 2;
      return {
        wav: encodeWav(
          pcm.subarray(0, targetBytes),
          options.sampleRate,
          options.channels,
        ),
        source: 'download',
        note: `downloaded from ${options.sourceUrl}`,
      };
    } catch (err) {
      downloadNote = err instanceof Error ? err.message : String(err);
    }
  }

  const pcm = await buildFromFixtures(options);
  return {
    wav: encodeWav(pcm, options.sampleRate, options.channels),
    source: 'fixtures',
    note: `built from the committed fixtures in Thue-Morse order (${downloadNote})`,
  };
}
