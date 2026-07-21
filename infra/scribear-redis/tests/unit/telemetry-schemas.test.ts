import { Value } from 'typebox/value';
import { describe, expect, it } from 'vitest';

import {
  STATUS_PROCESS_SCHEMA,
  STATUS_SESSION_SCHEMA,
} from '@scribear/node-server-schema';

import {
  NODE_SNAPSHOT_SCHEMA,
  PROVIDER_HEALTH_SCHEMA,
  SESSION_SNAPSHOT_SCHEMA,
  TRANSCRIPTION_HOST_SNAPSHOT_SCHEMA,
} from '#src/index.js';

/**
 * A provider entry exactly as transcription service's `GET /providers/health`
 * reports one, nulls and all. Kept literal rather than built from a helper: its
 * job is to fail if that endpoint's shape and this schema ever diverge, and a
 * helper shared with the schema could not do that.
 */
const LOCAL_PROVIDER = {
  providerUid: 'whisper-streaming',
  kind: 'local',
  status: 'degraded',
  activeSessions: 5,
  model: null,
  modelLoaded: true,
  owningWorkers: [
    {
      workerId: 0,
      utilization: 0.98,
      liveJobCount: 5,
      totalJobsRegistered: 41,
      contextIds: ['faster-whisper', 'silero'],
      alive: true,
    },
  ],
  endpoint: null,
  reachable: null,
  probeLatencyMs: null,
  detail: null,
};

const REMOTE_PROVIDER = {
  providerUid: 'lumen-granite',
  kind: 'remote',
  status: 'down',
  activeSessions: 1,
  model: 'granite-speech',
  modelLoaded: null,
  owningWorkers: [],
  endpoint: 'https://lumen.ncsa.illinois.edu/v1',
  reachable: false,
  probeLatencyMs: null,
  detail: 'ConnectTimeout: timed out',
};

/** A copy of `value` with one field removed, to test a required field. */
function without<T extends object>(value: T, field: keyof T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== field),
  ) as Partial<T>;
}

const HOST_SNAPSHOT = {
  updatedAt: 1_731_970_000_123,
  transcriptionHost: 'gpu-1',
  processUid: '8a1f1d3e-0c6f-4a0b-9b8e-4a3d1c2b5e6f',
  processStartedAt: '2026-07-20T00:00:00.000Z',
  numWorkers: 1,
  invalidProviderKeyRejects: 0,
  workers: LOCAL_PROVIDER.owningWorkers,
  providers: { whisper: LOCAL_PROVIDER, lumen_granite: REMOTE_PROVIDER },
};

describe('provider health schema', () => {
  it('should accept a local provider entry', () => {
    // Assert
    expect(Value.Check(PROVIDER_HEALTH_SCHEMA, LOCAL_PROVIDER)).toBe(true);
  });

  it('should accept a remote provider entry', () => {
    // Assert
    expect(Value.Check(PROVIDER_HEALTH_SCHEMA, REMOTE_PROVIDER)).toBe(true);
  });

  it('should reject an entry that omits an inapplicable field', () => {
    // The endpoint reports null for fields that do not apply to a kind rather
    // than omitting them, and this schema requires them for that reason: were
    // they optional, a field the endpoint stopped sending would validate as a
    // legitimate absence instead of failing here.
    //
    // Assert
    expect(
      Value.Check(PROVIDER_HEALTH_SCHEMA, without(LOCAL_PROVIDER, 'endpoint')),
    ).toBe(false);
  });

  it('should reject an unknown status', () => {
    // Arrange
    const unhealthy = { ...LOCAL_PROVIDER, status: 'unhealthy' };

    // Assert
    expect(Value.Check(PROVIDER_HEALTH_SCHEMA, unhealthy)).toBe(false);
  });
});

describe('transcription host snapshot schema', () => {
  it('should accept a full host snapshot', () => {
    // Assert
    expect(Value.Check(TRANSCRIPTION_HOST_SNAPSHOT_SCHEMA, HOST_SNAPSHOT)).toBe(
      true,
    );
  });

  it('should carry provider keys verbatim', () => {
    // Provider keys are operator-chosen configuration, so the schema must not
    // constrain them - including the snake_case ones the shipped provider
    // config template uses.
    //
    // Arrange
    const oddlyKeyed = {
      ...HOST_SNAPSHOT,
      providers: { 'Whisper.v2_EXPERIMENTAL': LOCAL_PROVIDER },
    };

    // Assert
    expect(Value.Check(TRANSCRIPTION_HOST_SNAPSHOT_SCHEMA, oddlyKeyed)).toBe(
      true,
    );
  });

  it('should reject a snapshot with no publish time', () => {
    // Without it a reader cannot tell a fresh snapshot from one about to
    // expire, which is the whole liveness mechanism.
    //
    // Assert
    expect(
      Value.Check(
        TRANSCRIPTION_HOST_SNAPSHOT_SCHEMA,
        without(HOST_SNAPSHOT, 'updatedAt'),
      ),
    ).toBe(false);
  });
});

describe('node server snapshot schemas', () => {
  it('should carry every field of the /status session record', () => {
    // The point of composing these rather than restating them: a field added
    // to the endpoint has to reach the backplane too, or the fleet view
    // silently lacks what a single instance's status page shows.
    //
    // Assert
    for (const field of Object.keys(STATUS_SESSION_SCHEMA.properties)) {
      expect(SESSION_SNAPSHOT_SCHEMA.properties).toHaveProperty(field);
    }
  });

  it('should carry every field of the /status process record', () => {
    // Assert
    for (const field of Object.keys(STATUS_PROCESS_SCHEMA.properties)) {
      expect(NODE_SNAPSHOT_SCHEMA.properties).toHaveProperty(field);
    }
  });

  it('should identify the reporting instance on both records', () => {
    // A session record without its owner is unattributable once more than one
    // instance is publishing, which is the only situation this exists for.
    //
    // Assert
    expect(SESSION_SNAPSHOT_SCHEMA.properties).toHaveProperty('nodeInstanceId');
    expect(NODE_SNAPSHOT_SCHEMA.properties).toHaveProperty('nodeInstanceId');
  });
});
