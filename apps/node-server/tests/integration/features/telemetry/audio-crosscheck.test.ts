import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, inject, vi } from 'vitest';
import type WebSocket from 'ws';

import { encodeAudioFrame } from '@scribear/audio-frame-protocol';
import {
  TranscriptionStreamClientMessageType,
  TranscriptionStreamServerMessageType,
} from '@scribear/node-server-schema';
import type { SessionTokenPayload } from '@scribear/session-manager-schema';
import {
  type SessionAudioSnapshot,
  type TelemetryRedisClient,
  createTelemetryRedisClient,
  parseSessionAudioSnapshot,
  transcriptionSessionAudioKey,
} from '@scribear/scribear-redis';

import createServer from '#src/server/create-server.js';
import { seedSession } from '#tests/utils/seed-session.js';
import { buildTestAppConfig } from '#tests/utils/use-server.js';

/**
 * PLAN-AUDIOVIZ §9 cross-check gate — the node-server hop.
 *
 * The other four legs pin the Python meter, the standalone page's DSP, the
 * webapp's render path, and (in `live_stack_crosscheck_test.py`) everything
 * between a websocket into the Transcription Service and the Redis key
 * `/fleet` reads. The rung this adds is the one an operator actually uses:
 * audio does not arrive at the Transcription Service from a test harness, it
 * arrives from **node-server**, forwarded on behalf of a source device.
 *
 * What only this leg can catch:
 *
 * - the SAFP frame surviving node-server's own decode-and-forward. It decodes
 *   each frame's envelope to correlate latency and then forwards the original
 *   bytes (`transcription-orchestrator.service.ts`), so a change that
 *   re-encoded, re-chunked or truncated the payload would move the metered
 *   levels while every offline leg still passed;
 * - the session and room uids the snapshot is **keyed and stamped** by. Those
 *   come from node-server's CONFIG message, not from the source device, and
 *   `/fleet` joins audio to sessions on exactly them. A node-server that
 *   forwarded perfect audio under the wrong uid would publish a snapshot no
 *   dashboard could ever attribute — invisible to a levels-only assertion,
 *   which is why the identity is asserted separately below;
 * - that the session config node-server relays (`transcriptionStreamConfig`,
 *   verbatim from Session Manager) is one the provider accepts. A rejected
 *   config produces no audio telemetry at all rather than wrong telemetry.
 *
 * It reuses the manifest the other legs use, so the number asserted here is
 * the same arithmetic RMS of the same samples, not a value copied off this
 * pipeline. The suite is possible at all because §12 moved metering above the
 * provider: the `debug` provider loads no model, so this needs no GPU.
 */

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../../..',
);

interface Manifest {
  toleranceDb: number;
  wav: {
    path: string;
    sampleRate: number;
    sampleCount: number;
    expected: { rmsDbfs: number; peakDbfs: number; clippingPct: number };
  };
}

const MANIFEST = JSON.parse(
  fs.readFileSync(
    path.join(REPO_ROOT, 'tools/audio-meter-crosscheck/fixtures.json'),
    'utf8',
  ),
) as Manifest;

const TOLERANCE_DB = MANIFEST.toleranceDb;
const WAV = MANIFEST.wav;

/**
 * Chunk size the kiosk sends (`AUDIO_CHUNK_MS`), mirrored by the sidecar's
 * canary. Metering at ingress happens per chunk, so streaming at the real
 * chunk size is part of what this checks.
 */
const CHUNK_MS = 100;

/** The Transcription Service's own publish throttle, waited out once. */
const PUBLISH_THROTTLE_MS = 2000;

const FAR_FUTURE = Math.floor(Date.now() / 1000) + 3600;
const NODE_INSTANCE_ID = 'audio-crosscheck-node';

/**
 * Reads the manifest's excerpt: the first `sampleCount` frames of the WAV, as
 * normalised floats.
 *
 * Parsed by hand rather than with a decoder library so this leg reads the file
 * the same way the Python legs do — `int16 / 32768` over the identical byte
 * range — and the two cannot disagree about which samples they describe.
 */
function excerpt(): Float64Array {
  const raw = fs.readFileSync(path.join(REPO_ROOT, WAV.path));
  expect(raw.toString('ascii', 0, 4)).toBe('RIFF');
  expect(raw.toString('ascii', 8, 12)).toBe('WAVE');

  // The chunk table is walked rather than assumed to be the canonical 44-byte
  // layout: this file carries a `LIST` chunk between `fmt ` and `data`, so
  // reading samples from a fixed offset would have started 26 bytes early and
  // silently shifted every sample. Found by asserting the layout instead of
  // trusting it.
  let offset = 12;
  let dataStart = -1;
  let dataBytes = 0;
  while (offset + 8 <= raw.length) {
    const id = raw.toString('ascii', offset, offset + 4);
    const size = raw.readUInt32LE(offset + 4);
    if (id === 'fmt ') {
      expect(raw.readUInt16LE(offset + 8)).toBe(1); // PCM
      expect(raw.readUInt16LE(offset + 10)).toBe(1); // mono
      expect(raw.readUInt32LE(offset + 12)).toBe(WAV.sampleRate);
      expect(raw.readUInt16LE(offset + 22)).toBe(16); // bits per sample
    } else if (id === 'data') {
      dataStart = offset + 8;
      dataBytes = size;
      break;
    }
    // Chunks are word-aligned, so an odd size is followed by a pad byte.
    offset += 8 + size + (size % 2);
  }
  expect(dataStart).toBeGreaterThan(0);
  expect(dataBytes / 2).toBeGreaterThanOrEqual(WAV.sampleCount);

  const samples = new Float64Array(WAV.sampleCount);
  for (let i = 0; i < WAV.sampleCount; i += 1) {
    samples[i] = raw.readInt16LE(dataStart + i * 2) / 32768;
  }
  return samples;
}

/**
 * Wraps `samples` in a canonical 16-bit PCM WAV container.
 *
 * Each chunk has to be a self-contained WAV: the service's `AudioDecoder`
 * opens every chunk with soundfile and validates its header, so a bare PCM
 * slice is rejected. This is what a source device sends.
 */
function wavChunk(samples: Float64Array, rate: number): Buffer {
  const header = Buffer.alloc(44);
  const dataBytes = samples.length * 2;
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataBytes, 40);

  const body = Buffer.alloc(dataBytes);
  for (let i = 0; i < samples.length; i += 1) {
    // Round-trips the same way the source samples were read, so a chunk built
    // from `excerpt()` carries the identical int16 values back.
    const clamped = Math.max(-1, Math.min(1, samples[i] ?? 0));
    body.writeInt16LE(Math.round(clamped * 32768), i * 2);
  }
  return Buffer.concat([header, body]);
}

/** Slices a signal into self-contained WAV chunks of `CHUNK_MS` each. */
function wavChunks(samples: Float64Array, rate: number): Buffer[] {
  const perChunk = (rate * CHUNK_MS) / 1000;
  const chunks: Buffer[] = [];
  for (let start = 0; start < samples.length; start += perChunk) {
    chunks.push(wavChunk(samples.slice(start, start + perChunk), rate));
  }
  return chunks;
}

/**
 * A 10 s signal whose amplitude alternates every half-chunk, plus its exact
 * RMS in dBFS.
 *
 * Exists for one reason: to fail if the ingress meter is fed anything other
 * than every sample. The speech excerpt cannot do that — mutation testing of
 * the Python leg showed that metering only half of each chunk moved speech
 * RMS and peak by well under the 0.5 dB tolerance, and passed every
 * excerpt-driven assertion. Speech is near enough stationary across 100 ms.
 *
 * Each chunk is 50 ms of a loud sine then 50 ms of a quiet one, 20 dB apart,
 * so dropping either half moves RMS by ~3 dB — six times the tolerance. The
 * excerpt pins the values; this pins completeness. Keep both.
 */
function alternatingSignal(rate: number): {
  samples: Float64Array;
  rmsDbfs: number;
} {
  const loud = 0.5;
  const quiet = 0.05;
  const half = (rate * CHUNK_MS) / 2000;
  const total = rate * 10;
  const samples = new Float64Array(total);
  for (let i = 0; i < total; i += 1) {
    const amplitude = i % (half * 2) < half ? loud : quiet;
    samples[i] = amplitude * Math.sin((2 * Math.PI * 1000 * i) / rate);
  }
  // Arithmetic, not measured: mean square of a full-cycle sine at amplitude A
  // is A^2/2, and the two halves contribute equally.
  const meanSquare = (loud * loud) / 2 / 2 + (quiet * quiet) / 2 / 2;
  return { samples, rmsDbfs: 10 * Math.log10(meanSquare) };
}

describe('§9 cross-check — the node-server hop', () => {
  let fastify: Awaited<ReturnType<typeof createServer>>['fastify'];
  let redis: TelemetryRedisClient;
  const openSockets: WebSocket[] = [];

  beforeAll(async () => {
    ({ fastify } = await createServer(
      buildTestAppConfig({
        telemetryPublisherConfig: {
          redisUrl: inject('redisUrl'),
          nodeInstanceId: NODE_INSTANCE_ID,
        },
      }),
    ));
    await fastify.ready();
    redis = createTelemetryRedisClient(inject('redisUrl'));
    await new Promise<void>((resolve) => redis.once('ready', resolve));
  }, 60_000);

  afterAll(async () => {
    for (const socket of openSockets) socket.terminate();
    await fastify.close();
    await redis.quit();
  });

  function signToken(payload: SessionTokenPayload): string {
    const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString(
      'base64url',
    );
    const signature = crypto
      .createHmac('sha256', inject('sessionTokenSigningKey'))
      .update(encoded)
      .digest('base64url');
    return `${encoded}.${signature}`;
  }

  /**
   * Seeds a session at the manifest's sample rate, opens a source connection
   * through node-server, and waits until node-server reports its upstream
   * open — audio sent before that has nowhere to go.
   */
  async function connectedSource(): Promise<{
    sessionUid: string;
    roomUid: string;
    ws: WebSocket;
  }> {
    const session = await seedSession({
      sessionManagerBaseUrl: inject('sessionManagerBaseUrl'),
      adminApiKey: inject('adminApiKey'),
      transcriptionProviderId: 'debug',
      // The manifest's rate, not the 48 kHz the other suites use: the
      // expectations are the arithmetic RMS of these samples at this rate.
      transcriptionStreamConfig: {
        sample_rate: WAV.sampleRate,
        num_channels: 1,
      },
    });

    const ws = await fastify.injectWS(
      `/api/node-server/v1/transcription-stream/${session.uid}/source`,
    );
    openSockets.push(ws);
    const messages: { type: TranscriptionStreamServerMessageType }[] = [];
    ws.on('message', (data: Buffer) => {
      try {
        messages.push(
          JSON.parse(data.toString('utf8')) as {
            type: TranscriptionStreamServerMessageType;
          },
        );
      } catch {
        /* SAFP frames are not JSON */
      }
    });
    ws.send(
      JSON.stringify({
        type: TranscriptionStreamClientMessageType.AUTH,
        sessionToken: signToken({
          sessionUid: session.uid,
          clientId: 'audio-crosscheck-source',
          scopes: ['SEND_AUDIO'],
          exp: FAR_FUTURE,
        }),
      }),
    );
    await vi.waitFor(
      () => {
        const status = [...messages]
          .reverse()
          .find(
            (m) =>
              m.type === TranscriptionStreamServerMessageType.SESSION_STATUS,
          );
        expect(status).toMatchObject({ transcriptionServiceConnected: true });
      },
      { timeout: 30_000 },
    );

    return { sessionUid: session.uid, roomUid: session.roomUid, ws };
  }

  /**
   * Sends each chunk as the SAFP frame a source device would send, **at the
   * rate a source device sends them**.
   *
   * The pacing is load-bearing, not politeness. node-server forwards to its
   * upstream through a `WebSocketClient` that sheds frames once the socket has
   * more than `backpressureHighWaterMark` (64 KiB) buffered, and each 100 ms
   * chunk of 16 kHz PCM16 is ~3.2 KiB — so roughly twenty frames of burst is
   * all it takes. Streaming ten seconds of audio in a tight loop measures that
   * shedding rather than the meter: the first attempt at this test did exactly
   * that and 4.2 s of 20 s arrived. A kiosk sends ten chunks a second and
   * never builds a buffer, so this does too.
   */
  async function stream(
    ws: WebSocket,
    chunks: Buffer[],
    tag: string,
  ): Promise<void> {
    for (const [index, chunk] of chunks.entries()) {
      ws.send(
        Buffer.from(
          encodeAudioFrame({ chunkId: `${tag}-${String(index)}` }, chunk),
        ),
      );
      await new Promise((resolve) => setTimeout(resolve, CHUNK_MS));
    }
  }

  /**
   * Waits for a published snapshot carrying at least `minSeconds` of ingress
   * audio.
   *
   * Polling on the *content* rather than on the key's existence is what makes
   * this deterministic: the very first chunk publishes immediately (it finds
   * the throttle with nothing to suppress), so a test that took the first
   * snapshot it saw would assert on 100 ms of audio and a window that is
   * almost entirely empty.
   */
  async function snapshotWithAudio(
    sessionUid: string,
    minSeconds: number,
  ): Promise<SessionAudioSnapshot> {
    let last: SessionAudioSnapshot | null = null;
    await vi.waitFor(
      async () => {
        const value = await redis.get(transcriptionSessionAudioKey(sessionUid));
        // A stale image is the likeliest reason for nothing at all here, and
        // it presents as a bare timeout that reads like a broken test. Before
        // §12 moved metering above the provider, the publisher early-returned
        // on `audio_stats is None` — which is always None for `debug` — so an
        // image built before that publishes host telemetry happily and no
        // audio telemetry ever. Checking for the host key distinguishes
        // "nothing is publishing" from "this image cannot publish this".
        if (value === null) {
          const hostKey = `scribe:v1:ts:${inject('transcriptionHostId')}`;
          const hostAlive = (await redis.exists(hostKey)) === 1;
          expect(
            hostAlive
              ? 'the transcription service is publishing host telemetry but no session audio: its image most likely predates the §12 stage graph (check for src/webserver/features/telemetry/session_audio_tracker.py in it). Rebuild it from transcription_service/Dockerfile_CPU, or unset SCRIBEAR_TRANSCRIPTION_SERVICE_IMAGE to let the setup build one.'
              : '',
          ).toBe('');
        }
        expect(value).not.toBeNull();
        const parsed = parseSessionAudioSnapshot(value ?? '');
        // Parsed, not cast: this leg carries the payload across the same
        // language boundary `/fleet` reads it over, so a shape drift should
        // fail here rather than surface as an undefined field later.
        expect(
          parsed.ok ? '' : `${parsed.reason}: ${parsed.errors.join('; ')}`,
        ).toBe('');
        if (!parsed.ok) throw new Error('unreachable');
        const ingress = parsed.value.stages.find((s) => s.stage === 'ingress');
        expect(ingress?.audioSeconds ?? 0).toBeGreaterThanOrEqual(minSeconds);
        last = parsed.value;
      },
      { timeout: 40_000, interval: 250 },
    );
    // `vi.waitFor` only returns once the callback stopped throwing, so this
    // has been assigned; the assertion is for the type, not the control flow.
    return last as unknown as SessionAudioSnapshot;
  }

  /** Pulls one stage out of a snapshot by id. */
  function stage(snapshot: SessionAudioSnapshot, id: string) {
    const found = snapshot.stages.find((s) => s.stage === id);
    if (found === undefined) {
      throw new Error(
        `no ${id} stage; got ${snapshot.stages.map((s) => s.stage).join(', ')}`,
      );
    }
    return found;
  }

  describe('levels through the full stack', (it) => {
    it(
      'reports the manifest dBFS for audio forwarded by node-server',
      { timeout: 180_000 },
      async () => {
        // Arrange - the manifest's excerpt is exactly one 10 s metering
        // window at 16 kHz, so the meter averages precisely these samples.
        const chunks = wavChunks(excerpt(), WAV.sampleRate);
        expect(chunks).toHaveLength(100);
        const { sessionUid, ws } = await connectedSource();

        // Act - one full pass fills the window, the throttle is waited out so
        // the publish that follows is not the first-chunk one, and a short
        // second pass supplies the frames to trigger it.
        //
        // Those extra frames are the *start* of the same excerpt, so the
        // window they roll into is a rotation of it - the identical multiset
        // of samples in a different order - and RMS and peak are therefore
        // unchanged. (Noise floor would not be: it is a percentile over 1 s
        // sub-windows, whose boundaries a rotation moves, which is why the
        // Python leg does not assert it either and neither does this.)
        await stream(ws, chunks, 'pass1');
        await new Promise((resolve) =>
          setTimeout(resolve, PUBLISH_THROTTLE_MS + 200),
        );
        await stream(ws, chunks.slice(0, 5), 'pass2');
        const snapshot = await snapshotWithAudio(sessionUid, 10);

        // Assert
        const levels = stage(snapshot, 'ingress').levels;
        expect(levels).not.toBeNull();
        expect(levels?.rmsDbfs ?? NaN).toBeCloseTo(
          WAV.expected.rmsDbfs,
          // `toBeCloseTo`'s digits argument is a power of ten, so this is a
          // tighter bound than the manifest's 0.5 dB rather than a looser one.
          1,
        );
        expect(Math.abs((levels?.peakDbfs ?? NaN) - WAV.expected.peakDbfs)).
          toBeLessThan(TOLERANCE_DB);
        // Speech at -26 dBFS is nowhere near the rail. Anything above zero
        // means the clipping rule has regressed into firing on undistorted
        // audio, the defect 4ea4bf6 fixed.
        expect(levels?.clippingPct).toBe(WAV.expected.clippingPct);
        expect(levels?.silence).toBe(false);
      },
    );

    it(
      'meters every sample of every chunk it forwards',
      { timeout: 180_000 },
      async () => {
        // Arrange - the excerpt cannot detect a meter fed a subset of each
        // chunk; this signal can. See `alternatingSignal`.
        const { samples, rmsDbfs } = alternatingSignal(WAV.sampleRate);
        const chunks = wavChunks(samples, WAV.sampleRate);
        const { sessionUid, ws } = await connectedSource();

        // Act
        await stream(ws, chunks, 'alt1');
        await new Promise((resolve) =>
          setTimeout(resolve, PUBLISH_THROTTLE_MS + 200),
        );
        await stream(ws, chunks.slice(0, 5), 'alt2');
        const snapshot = await snapshotWithAudio(sessionUid, 10);

        // Assert - halving each chunk would land ~3 dB away.
        const levels = stage(snapshot, 'ingress').levels;
        expect(Math.abs((levels?.rmsDbfs ?? NaN) - rmsDbfs)).toBeLessThan(
          TOLERANCE_DB,
        );
      },
    );
  });

  describe('the identity node-server stamps on the telemetry', (it) => {
    it(
      'keys and stamps the snapshot with the uids /fleet joins on',
      { timeout: 180_000 },
      async () => {
        // Arrange - the levels assertions above would pass unchanged if
        // node-server sent the wrong session uid upstream: the audio would be
        // metered perfectly and published under a key no dashboard looks up.
        // These uids reach the Transcription Service only in node-server's
        // CONFIG message, so this is the one leg that can check them.
        const { sessionUid, roomUid, ws } = await connectedSource();
        const chunks = wavChunks(excerpt(), WAV.sampleRate);

        // Act
        await stream(ws, chunks.slice(0, 20), 'ident');
        const snapshot = await snapshotWithAudio(sessionUid, 0.1);

        // Assert - keyed by the session uid (the read above would have failed
        // otherwise) and carrying both uids in the payload.
        expect(snapshot.sessionUid).toBe(sessionUid);
        expect(snapshot.roomUid).toBe(roomUid);
        expect(snapshot.transcriptionHost).toBe(inject('transcriptionHostId'));

        // Assert - ingress is the source of the graph. Depth is derived at
        // publish time from declared inputs, so only a real publish shows it.
        const ingress = stage(snapshot, 'ingress');
        expect(ingress.inputs).toEqual([]);
        expect(ingress.depth).toBe(1);
      },
    );
  });
});
