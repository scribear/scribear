import { afterEach, describe, expect } from 'vitest';

import type { BaseLogger } from '@scribear/base-fastify-server';

import { CanaryAuthClient } from '#src/server/shared/canary/canary-auth.js';
import { CanarySession } from '#src/server/shared/canary/canary-session.js';
import { CanaryOutcome } from '#src/server/shared/canary/canary-types.js';
import {
  type AudioChunk,
  decodeWav,
  encodeWav,
  sliceIntoChunks,
} from '#src/server/shared/canary/wav.js';
import {
  type FakeNodeServer,
  type FakeNodeServerOptions,
  startFakeNodeServer,
} from '#tests/fixtures/fake-node-server.js';

/**
 * A2 acceptance gate.
 *
 * The plan's gate is: a canary run against a healthy session asserts
 * first-transcript < N s and overlap > X%, and — under fault injection — the
 * canary reports "no captions" within one probe interval.
 *
 * These run the real `CanarySession` against a real WebSocket server speaking
 * the real protocol. What is *not* covered: a real transcription model, real
 * network conditions, and the actual `scribe.engrit` deployment. This proves
 * the canary correctly detects the conditions it is shown; it cannot prove the
 * deployment produces them.
 */

const SCRIPT = 'the birch canoe slid on the smooth planks';
const SAMPLE_RATE = 16_000;

const logger = {
  debug: () => undefined,
  warn: () => undefined,
  info: () => undefined,
  error: () => undefined,
} as unknown as BaseLogger;

/** Half a second of silent 16 kHz mono audio, sliced as a real source would. */
function testChunks(): AudioChunk[] {
  const pcm = Buffer.alloc(SAMPLE_RATE, 0);
  return sliceIntoChunks(decodeWav(encodeWav(pcm, SAMPLE_RATE, 1)), 100);
}

function canaryFor(server: FakeNodeServer): CanarySession {
  const auth = new CanaryAuthClient({
    sessionManagerBaseUrl: server.baseUrl,
    deviceToken: 'device-uid:secret',
    timeoutMs: 2_000,
  });
  return new CanarySession(
    {
      nodeServerBaseUrl: server.baseUrl,
      expectedTranscript: SCRIPT,
      // Short windows keep the suite fast; the logic under test is unchanged.
      runDurationMs: 800,
      drainMs: 300,
      upstreamWaitMs: 3_000,
    },
    auth,
    logger,
  );
}

describe('synthetic canary (A2)', () => {
  let server: FakeNodeServer | null = null;

  afterEach(async () => {
    await server?.close();
    server = null;
  });

  async function start(options: FakeNodeServerOptions = {}) {
    server = await startFakeNodeServer(options);
    return server;
  }

  describe('healthy session', (it) => {
    it('streams audio, receives captions, and scores them', async () => {
      // Arrange
      const fake = await start();

      // Act
      const result = await canaryFor(fake).run(testChunks());

      // Assert
      expect(result.outcome).toBe(CanaryOutcome.OK);
      expect(result.chunksSent).toBeGreaterThan(0);
      expect(result.transcriptCount).toBeGreaterThan(0);
      expect(result.accuracy).not.toBeNull();
      // The fake emits the exact script, so every expected word must appear.
      expect(result.accuracy?.recall).toBe(1);
    });

    it('measures time to first transcript', async () => {
      // Arrange
      const fake = await start({ firstTranscriptDelayMs: 200 });

      // Act
      const result = await canaryFor(fake).run(testChunks());

      // Assert — the plan's "first transcript < N s" assertion.
      expect(result.timeToFirstTranscriptMs).not.toBeNull();
      expect(result.timeToFirstTranscriptMs).toBeLessThan(3_000);
    });

    it('opens both a source and a viewer socket', async () => {
      // Arrange — reading transcripts on the source socket would skip the
      // `/client` fan-out path that real viewers depend on.
      const fake = await start();

      // Act
      await canaryFor(fake).run(testChunks());

      // Assert
      expect(fake.authenticated.source).toBe(1);
      expect(fake.authenticated.client).toBe(1);
    });

    it('sends decodable SAFP frames carrying complete WAV chunks', async () => {
      // Arrange — the receiver parses each frame as a standalone audio file.
      const fake = await start();

      // Act
      await canaryFor(fake).run(testChunks());

      // Assert
      expect(fake.receivedChunks.length).toBeGreaterThan(0);
      const first = fake.receivedChunks[0];
      expect(first).toBeDefined();
      const decoded = decodeWav(first!);
      expect(decoded.sampleRate).toBe(SAMPLE_RATE);
      expect(decoded.channels).toBe(1);
    });

    it('streams at realtime rather than as fast as it can', async () => {
      // Arrange — the transcription service disconnects a session that sends
      // audio faster than realtime, so a flat-out canary would manufacture the
      // very fault it is meant to detect.
      const fake = await start();

      // Act
      const result = await canaryFor(fake).run(testChunks());

      // Assert — ~800 ms of streaming at 100 ms per chunk is roughly 8 chunks.
      // A canary ignoring pacing would send hundreds.
      expect(result.chunksSent).toBeLessThan(20);
    });
  });

  describe('fault injection', (it) => {
    it('reports no-captions when transcripts stop (the A2 gate)', async () => {
      // Arrange — node accepts the stream and claims a healthy upstream, but
      // nothing ever comes back. This is the failure users report as "captions
      // just stopped" and that probes and logs alone can miss.
      const fake = await start({ silent: true });

      // Act
      const result = await canaryFor(fake).run(testChunks());

      // Assert
      expect(result.outcome).toBe(CanaryOutcome.NO_TRANSCRIPTS);
      expect(result.chunksSent).toBeGreaterThan(0);
      expect(result.transcriptCount).toBe(0);
      expect(result.accuracy).toBeNull();
    });

    it('reports upstream-down when the node never links to transcription', async () => {
      // Arrange — the BUG.txt shape: the session looks alive but no upstream.
      const fake = await start({ upstreamDown: true });

      // Act
      const result = await canaryFor(fake).run(testChunks());

      // Assert
      expect(result.outcome).toBe(CanaryOutcome.UPSTREAM_DOWN);
      expect(result.transcriptionServiceConnected).toBe(false);
    });

    it('reports auth-failed without retrying a rejected token', async () => {
      // Arrange
      const fake = await start({ rejectAuth: true });

      // Act
      const result = await canaryFor(fake).run(testChunks());

      // Assert
      expect(result.outcome).toBe(CanaryOutcome.AUTH_FAILED);
      expect(result.error).toContain('401');
    });

    it('stays quiet when no session is scheduled', async () => {
      // Arrange — an idle canary room is not an outage. Alerting here would
      // make the canary red every night and worthless by morning.
      const fake = await start({ activeSessionUid: null });

      // Act
      const result = await canaryFor(fake).run(testChunks());

      // Assert
      expect(result.outcome).toBe(CanaryOutcome.NO_SESSION);
      expect(result.error).toContain('No session');
    });

    it('scores low recall when captions come back wrong', async () => {
      // Arrange — captions flow, so this is a degradation rather than an
      // outage, and must not be reported as "down".
      const fake = await start({ script: ['banana', 'helicopter', 'tuesday'] });

      // Act
      const result = await canaryFor(fake).run(testChunks());

      // Assert
      expect(result.outcome).toBe(CanaryOutcome.OK);
      expect(result.accuracy?.recall).toBe(0);
    });
  });
});
