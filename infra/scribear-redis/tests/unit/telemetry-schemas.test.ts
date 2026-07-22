import { Value } from 'typebox/value';
import { describe, expect, it } from 'vitest';

import {
  STATUS_PROCESS_SCHEMA,
  STATUS_SESSION_SCHEMA,
} from '@scribear/node-server-schema';

import {
  AUDIO_LEVEL_STATS_SCHEMA,
  NODE_SNAPSHOT_SCHEMA,
  PROVIDER_HEALTH_SCHEMA,
  SESSION_AUDIO_SNAPSHOT_SCHEMA,
  SESSION_SNAPSHOT_SCHEMA,
  TRANSCRIPTION_HOST_SNAPSHOT_SCHEMA,
  TRANSCRIPTION_WORKER_SCHEMA,
  VAD_STATS_SCHEMA,
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
      activeJobs: [
        { jobId: 12, sessionUid: 'session-1', roomUid: 'room-1' },
        { jobId: 13, sessionUid: null, roomUid: null },
      ],
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

describe('transcription worker schema', () => {
  const WORKER = LOCAL_PROVIDER.owningWorkers[0];

  it('should accept a worker with populated activeJobs', () => {
    // Assert - one job correlated to a session/room, one with neither known
    expect(Value.Check(TRANSCRIPTION_WORKER_SCHEMA, WORKER)).toBe(true);
  });

  it('should accept a worker with no active jobs', () => {
    // Assert
    expect(
      Value.Check(TRANSCRIPTION_WORKER_SCHEMA, { ...WORKER, activeJobs: [] }),
    ).toBe(true);
  });

  it('should reject activeJobs missing a required field', () => {
    // roomUid dropped rather than null: a field this service stopped sending
    // must fail validation here, not read as a legitimate absence.
    //
    // Assert
    expect(
      Value.Check(TRANSCRIPTION_WORKER_SCHEMA, {
        ...WORKER,
        activeJobs: [{ jobId: 1, sessionUid: null }],
      }),
    ).toBe(false);
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

describe('session audio snapshot schema', () => {
  /**
   * A record exactly as `RedisSessionAudioPublisher` publishes one, nulls and
   * all. Kept literal rather than built from a helper, for the same reason
   * `HOST_SNAPSHOT` is: its job is to fail if the publisher's shape and this
   * schema ever diverge.
   */
  /**
   * A vadStats value exactly as `RedisSessionAudioPublisher` publishes one
   * when VAD ran and found speech, for the same reason SESSION_AUDIO is
   * kept literal.
   */
  const VAD_STATS = {
    vadEnabled: true,
    speechActiveRatio: 0.5,
    segmentCount: 2,
    meanSegmentDurationSec: 0.25,
    speechToPauseRatio: 1,
    snrDb: 12.5,
  };

  const SESSION_AUDIO = {
    rmsDbfs: -18.4,
    peakDbfs: -6.2,
    clippingPct: 0,
    silence: false,
    noiseFloorDbfs: -42.1,
    vadStats: VAD_STATS,
    sessionUid: 'session-1',
    roomUid: 'room-1',
    transcriptionHost: 'gpu-1',
    updatedAt: 1_731_970_000_123,
  };

  it('should accept a full vad stats object', () => {
    // Assert
    expect(Value.Check(VAD_STATS_SCHEMA, VAD_STATS)).toBe(true);
  });

  it('should accept a vad stats object with every field but vadEnabled null', () => {
    // Assert - VAD off: only vadEnabled is meaningful.
    expect(
      Value.Check(VAD_STATS_SCHEMA, {
        vadEnabled: false,
        speechActiveRatio: null,
        segmentCount: null,
        meanSegmentDurationSec: null,
        speechToPauseRatio: null,
        snrDb: null,
      }),
    ).toBe(true);
  });

  it('should accept a full session audio snapshot', () => {
    // Assert
    expect(Value.Check(SESSION_AUDIO_SNAPSHOT_SCHEMA, SESSION_AUDIO)).toBe(
      true,
    );
  });

  it('should reject a snapshot with a null transcriptionHost', () => {
    // Assert - every host publishes under its own transcription_host_id
    // (config-derived, defaults to hostname), so there is no case where a
    // publish happens without one, unlike roomUid.
    expect(
      Value.Check(SESSION_AUDIO_SNAPSHOT_SCHEMA, {
        ...SESSION_AUDIO,
        transcriptionHost: null,
      }),
    ).toBe(false);
  });

  it('should accept a snapshot with no roomUid', () => {
    // Assert - an older node-server peer, or a session opened before the
    // CONFIG message carried it.
    expect(
      Value.Check(SESSION_AUDIO_SNAPSHOT_SCHEMA, {
        ...SESSION_AUDIO,
        roomUid: null,
      }),
    ).toBe(true);
  });

  it('should accept a snapshot with a null vadStats', () => {
    // Assert - VAD off, or no VAD ran this batch: a legitimate value, not
    // a malformed payload.
    expect(
      Value.Check(SESSION_AUDIO_SNAPSHOT_SCHEMA, {
        ...SESSION_AUDIO,
        vadStats: null,
      }),
    ).toBe(true);
  });

  it('should reject a snapshot missing the vadStats key entirely', () => {
    // Assert - vadStats is a required key even though its value can be
    // null: the publisher always writes it, so a missing key means the
    // shape drifted, not that VAD was off.
    expect(
      Value.Check(
        SESSION_AUDIO_SNAPSHOT_SCHEMA,
        without(SESSION_AUDIO, 'vadStats'),
      ),
    ).toBe(false);
  });

  it('should reject a snapshot missing a stats field', () => {
    // Assert
    expect(
      Value.Check(
        SESSION_AUDIO_SNAPSHOT_SCHEMA,
        without(SESSION_AUDIO, 'silence'),
      ),
    ).toBe(false);
  });

  it('should reject a stats-only payload with no envelope', () => {
    // Assert - AUDIO_LEVEL_STATS_SCHEMA alone accepts just the meter fields.
    const { rmsDbfs, peakDbfs, clippingPct, silence, noiseFloorDbfs } =
      SESSION_AUDIO;
    const statsOnly = {
      rmsDbfs,
      peakDbfs,
      clippingPct,
      silence,
      noiseFloorDbfs,
    };

    expect(Value.Check(AUDIO_LEVEL_STATS_SCHEMA, statsOnly)).toBe(true);
    expect(Value.Check(SESSION_AUDIO_SNAPSHOT_SCHEMA, statsOnly)).toBe(false);
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
