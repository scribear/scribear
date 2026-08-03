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
  type SnapshotParseResult,
  type TelemetryRedisClient,
  createTelemetryRedisClient,
  nodeSnapshotKey,
  parseNodeSnapshot,
  parseSessionSnapshot,
  parseTranscriptionHostSnapshot,
  sessionSnapshotKey,
  transcriptionHostSnapshotKey,
} from '@scribear/scribear-redis';

import createServer from '#src/server/create-server.js';
import type { AppDependencies } from '#src/server/dependency-injection/app-dependencies.js';
import { seedSession } from '#tests/utils/seed-session.js';
import { buildTestAppConfig } from '#tests/utils/use-server.js';

const FAR_FUTURE = Math.floor(Date.now() / 1000) + 3600;
const DEBUG_SAMPLE_RATE = 48000;
const DEBUG_NUM_CHANNELS = 1;
const NODE_INSTANCE_ID = 'crosscheck-node-instance';
/** Never seeded. Only ever used as the URL half of a mismatched pair. */
const UNKNOWN_SESSION_UID = '00000000-0000-0000-0000-000000000abc';
/** Deliberately not `UNKNOWN_SESSION_UID`: the mismatch is the point. */
const MISMATCHED_SESSION_UID = '00000000-0000-0000-0000-000000000999';

const TEST_AUDIO = fs.readFileSync(
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../../../../test_audio_files/musical_chords/mono_f64le.wav',
  ),
);

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
 * The failing branch of a parse result, rendered for an assertion message.
 * `expect(result.ok).toBe(true)` alone reports `false !== true`, which says
 * nothing about which field drifted - and the field is the entire finding.
 */
function describeFailure(result: SnapshotParseResult<unknown>): string {
  return result.ok ? '' : `${result.reason}: ${result.errors.join('; ')}`;
}

/**
 * Every payload the fleet telemetry backplane carries is written by one
 * service and read by another, and `@scribear/scribear-redis` holds the schema
 * both sides are supposed to agree on. Nothing checked that agreement against
 * a real publisher until this suite: the fixtures in the reader's own tests
 * were written *from* those schemas, so they encode whatever the schema says
 * rather than testing it, and a green suite could not disprove a drift. That
 * is not hypothetical - retrofitting validation onto
 * `TRANSCRIPTION_HOST_SNAPSHOT_SCHEMA` found it had declared `contextIds` as
 * strings since it was written, while the publisher has always emitted
 * integers.
 *
 * So the oracle here is the other implementation, never a fixture: each
 * assertion takes the bytes a real publisher wrote to a real Redis and runs
 * the reader's own parser over them. This is what
 * `FleetTelemetryService._readIndexed`'s `onInvalid: 'drop'` needs before it
 * can be trusted for an index - a hard drop on an unverified mirror would
 * blank that half of the fleet view on precisely the drift it exists to catch.
 *
 * This suite lives in node-server rather than in admin-server (the reader)
 * because this is the only integration setup that already runs *both*
 * publishers: node-server itself, in process, and the shipped Transcription
 * Service image in a container. Standing a Python container up inside
 * admin-server's suite to check a schema that ships from a third package would
 * buy the same evidence for a much larger fixed cost.
 */
describe('published snapshots parse under the reader’s schemas', () => {
  let fastify: Awaited<ReturnType<typeof createServer>>['fastify'];
  let redis: TelemetryRedisClient;
  let sourceWs: WebSocket;

  let nodeRaw: string | null;
  let sessionRaw: string | null;
  let hostRaw: string | null;

  let sessionUid: string;

  beforeAll(async () => {
    const session = await seedSession({
      sessionManagerBaseUrl: inject('sessionManagerBaseUrl'),
      adminApiKey: inject('adminApiKey'),
      transcriptionProviderId: 'debug',
      transcriptionStreamConfig: {
        sample_rate: DEBUG_SAMPLE_RATE,
        num_channels: DEBUG_NUM_CHANNELS,
      },
    });
    sessionUid = session.uid;

    // The real server with telemetry publishing switched on, so the records
    // read back below come from the production path: real metrics service,
    // real `StatusSnapshotService` join, real publisher, real Redis. A
    // hand-built `statusSnapshotService` would put the fixture back.
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

    const base = `/api/node-server/v1/transcription-stream/${sessionUid}`;

    // A rejected connection first, so `authFailures` and `wsCloses` are
    // non-empty in the record published below. Both are arrays of objects the
    // schema describes field by field, and an empty array satisfies any
    // element schema at all - see the emptiness guard further down.
    //
    // The token names a different session from the URL, which is rejected
    // before the orchestrator is reached; that is why neither uid has to
    // exist in Session Manager.
    const rejected = await fastify.injectWS(
      `/api/node-server/v1/transcription-stream/${UNKNOWN_SESSION_UID}/source`,
    );
    rejected.send(
      JSON.stringify({
        type: TranscriptionStreamClientMessageType.AUTH,
        sessionToken: signToken({
          sessionUid: MISMATCHED_SESSION_UID,
          clientId: 'crosscheck-rejected',
          scopes: ['SEND_AUDIO'],
          exp: FAR_FUTURE,
        }),
      }),
    );
    await new Promise<void>((resolve) =>
      rejected.once('close', () => {
        resolve();
      }),
    );

    // Then a real session, driven far enough that the upstream reaches OPEN
    // and audio round-trips: that is what populates the live gauges, the
    // upstream state transitions and the transcription host's own
    // `activeSessions`.
    sourceWs = await fastify.injectWS(`${base}/source`);
    const messages: { type: TranscriptionStreamServerMessageType }[] = [];
    sourceWs.on('message', (data: Buffer) => {
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
    sourceWs.send(
      JSON.stringify({
        type: TranscriptionStreamClientMessageType.AUTH,
        sessionToken: signToken({
          sessionUid,
          clientId: 'crosscheck-source',
          scopes: ['SEND_AUDIO', 'RECEIVE_TRANSCRIPTIONS'],
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
    sourceWs.send(
      Buffer.from(
        encodeAudioFrame({ chunkId: crypto.randomUUID() }, TEST_AUDIO),
      ),
    );

    // node-server's beat is driven explicitly rather than waited for, so the
    // records are known to post-date the traffic above.
    await fastify.diContainer
      .resolve<AppDependencies['redisTelemetryPublisher']>(
        'redisTelemetryPublisher',
      )
      .publishOnce();

    nodeRaw = await redis.get(nodeSnapshotKey(NODE_INSTANCE_ID));
    sessionRaw = await redis.get(sessionSnapshotKey(sessionUid));

    // The transcription host beats on its own timer inside the container
    // (`TRANSCRIPTION_HOST_HEARTBEAT_SEC` = 5 s) and there is no way to
    // trigger one from here, so this polls for a record that already reflects
    // the live session rather than for the first record of any kind.
    await vi.waitFor(
      async () => {
        hostRaw = await redis.get(
          transcriptionHostSnapshotKey(inject('transcriptionHostId')),
        );
        expect(hostRaw).not.toBeNull();
        const parsed = JSON.parse(hostRaw ?? 'null') as {
          providers: Record<string, { activeSessions: number }>;
        };
        expect(parsed.providers['debug']?.activeSessions).toBeGreaterThan(0);
      },
      { timeout: 30_000, interval: 500 },
    );
  }, 120_000);

  afterAll(async () => {
    sourceWs.terminate();
    await fastify.close();
    await redis.quit();
  });

  describe('node-server’s publisher', (it) => {
    it('writes an instance record that parses as a NodeSnapshot', () => {
      // Arrange
      expect(nodeRaw).not.toBeNull();

      // Act
      const result = parseNodeSnapshot(nodeRaw ?? '');

      // Assert
      expect(describeFailure(result)).toBe('');
      expect(result.ok).toBe(true);
    });

    it('writes a session record that parses as a SessionSnapshot', () => {
      // Arrange
      expect(sessionRaw).not.toBeNull();

      // Act
      const result = parseSessionSnapshot(sessionRaw ?? '');

      // Assert
      expect(describeFailure(result)).toBe('');
      expect(result.ok).toBe(true);
    });

    it('published a record whose element-bearing arrays are populated', () => {
      // Arrange - the parse above is only as strong as the payload it ran on.
      // Every array in these schemas has a described element type, and `[]`
      // satisfies all of them, so a record produced by an idle process would
      // parse while exercising none of `LATENCY_SERIES_SCHEMA`, the ws-close
      // record or the auth-failure record. This asserts the traffic the
      // fixture set up actually reached the counters.
      const node = JSON.parse(nodeRaw ?? 'null') as {
        wsCloses: unknown[];
        authFailures: unknown[];
        upstreamStateTransitions: unknown[];
      };
      const session = JSON.parse(sessionRaw ?? 'null') as {
        upstreamState: string;
        sourceCount: number;
      };

      // Assert
      expect(node.wsCloses.length).toBeGreaterThan(0);
      expect(node.authFailures.length).toBeGreaterThan(0);
      expect(node.upstreamStateTransitions.length).toBeGreaterThan(0);
      expect(session.sourceCount).toBeGreaterThan(0);
      expect(session.upstreamState).toBe('OPEN');
    });
  });

  describe('the Transcription Service’s publisher', (it) => {
    it('writes a host record that parses as a TranscriptionHostSnapshot', () => {
      // Arrange - these bytes were produced by `redis_telemetry_publisher.py`
      // inside the shipped image, not by anything in this repo's TypeScript.
      expect(hostRaw).not.toBeNull();

      // Act
      const result = parseTranscriptionHostSnapshot(hostRaw ?? '');

      // Assert
      expect(describeFailure(result)).toBe('');
      expect(result.ok).toBe(true);
    });

    it('published the live session, so the parse ran on a populated record', () => {
      // Arrange
      const parsed = JSON.parse(hostRaw ?? 'null') as {
        transcriptionHost: string;
        numWorkers: number;
        workers: { workerId: number }[];
        providers: Record<string, { kind: string; activeSessions: number }>;
      };

      // Assert - `activeSessions` is the field that proves this record was
      // taken while node-server's upstream was open, rather than during the
      // container's idle warm-up.
      expect(parsed.transcriptionHost).toBe(inject('transcriptionHostId'));
      expect(parsed.workers.length).toBe(parsed.numWorkers);
      expect(parsed.providers['debug']?.kind).toBe('debug');
      expect(parsed.providers['debug']?.activeSessions).toBeGreaterThan(0);
    });
  });
});
