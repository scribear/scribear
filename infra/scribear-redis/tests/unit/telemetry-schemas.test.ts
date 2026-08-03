import { Value } from 'typebox/value';
import { describe, expect, it } from 'vitest';

import {
  STATUS_PROCESS_SCHEMA,
  STATUS_SESSION_SCHEMA,
} from '@scribear/node-server-schema';

import {
  AUDIO_LEVEL_STATS_SCHEMA,
  AUDIO_STAGE_SCHEMA,
  NODE_SNAPSHOT_SCHEMA,
  PROVIDER_HEALTH_SCHEMA,
  SESSION_AUDIO_SNAPSHOT_SCHEMA,
  SESSION_SNAPSHOT_SCHEMA,
  type SnapshotParseResult,
  TRANSCRIPTION_HOST_SNAPSHOT_SCHEMA,
  TRANSCRIPTION_WORKER_SCHEMA,
  VAD_STATS_SCHEMA,
  parseSessionAudioSnapshot,
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
  sessionsRefusedCapacityTotal: 2,
  model: null,
  modelLoaded: true,
  owningWorkers: [
    {
      workerId: 0,
      utilization: 0.98,
      liveJobCount: 5,
      totalJobsRegistered: 41,
      contextIds: [1, 2],
      alive: true,
      activeJobs: [
        { jobId: 12, sessionUid: 'session-1', roomUid: 'room-1' },
        { jobId: 13, sessionUid: null, roomUid: null },
      ],
      estimatedCapacitySessions: 8,
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
  // Never subject to local admission control, so always 0 - the honest
  // reading for a remote provider, not a gap.
  sessionsRefusedCapacityTotal: 0,
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

  it('should accept a null estimatedCapacitySessions', () => {
    // "Not measured yet" (warm-up) - the estimator always has an answer to
    // give, but not always a real one, so this field is always present and
    // sometimes null rather than sometimes absent
    // (archived-plans/2026-07-27-02-PLAN-AdmissionControl.md §5).
    //
    // Assert
    expect(
      Value.Check(TRANSCRIPTION_WORKER_SCHEMA, {
        ...WORKER,
        estimatedCapacitySessions: null,
      }),
    ).toBe(true);
  });

  it('should reject estimatedCapacitySessions missing entirely', () => {
    // Assert
    expect(
      Value.Check(
        TRANSCRIPTION_WORKER_SCHEMA,
        without(WORKER!, 'estimatedCapacitySessions'),
      ),
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
   * A vadStats value exactly as `RedisSessionAudioPublisher` publishes one
   * when VAD ran and found speech, kept literal rather than built from a
   * helper for the same reason `HOST_SNAPSHOT` is: its job is to fail if the
   * publisher's shape and this schema ever diverge.
   */
  const VAD_STATS = {
    vadEnabled: true,
    speechActiveRatio: 0.5,
    segmentCount: 2,
    meanSegmentDurationSec: 0.25,
    speechToPauseRatio: 1,
    snrDb: 12.5,
  };

  const LEVELS = {
    rmsDbfs: -18.4,
    peakDbfs: -6.2,
    clippingPct: 0,
    silence: false,
    noiseFloorDbfs: -42.1,
  };

  /**
   * The graph a whisper session reports: the stream controller's ingress
   * meter, the provider job's decode point, and the detector - which counts
   * the speech seconds it passed on and meters no levels. Literal for the same
   * reason the rest of this fixture is, and three-deep because a two-point
   * fixture cannot tell a resolved depth from a hardcoded one.
   */
  const STAGES = [
    {
      stage: 'ingress',
      label: 'Source ingress',
      depth: 1,
      inputs: [],
      levels: LEVELS,
      vad: null,
      audioSeconds: 123.4,
    },
    {
      stage: 'asr_input',
      label: 'ASR input (worker decode)',
      depth: 2,
      inputs: ['ingress'],
      levels: LEVELS,
      vad: null,
      audioSeconds: 122.9,
    },
    {
      stage: 'vad',
      label: 'VAD (Silero)',
      depth: 3,
      inputs: ['asr_input'],
      levels: null,
      vad: VAD_STATS,
      audioSeconds: 47.2,
    },
  ];

  const SESSION_AUDIO = {
    stages: STAGES,
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

  it('should accept a full three-stage snapshot', () => {
    // Assert - one point per depth, each naming the one above it.
    expect(Value.Check(SESSION_AUDIO_SNAPSHOT_SCHEMA, SESSION_AUDIO)).toBe(
      true,
    );
  });

  it('should accept a stage that counts throughput but meters no levels', () => {
    // levels: null is a real configuration, not a degraded one - the debug
    // provider closes the funnel by seconds alone, and a schema that required
    // levels would force it to fabricate them to stay visible.
    //
    // Arrange
    const secondsOnly = { ...STAGES[1]!, levels: null, vad: null };

    // Assert
    expect(Value.Check(AUDIO_STAGE_SCHEMA, secondsOnly)).toBe(true);
  });

  it('should accept a stage that runs no detector', () => {
    // Assert - vad: null means no detector at this point at all, distinct
    // from a VadStats whose vadEnabled is false.
    expect(Value.Check(AUDIO_STAGE_SCHEMA, STAGES[0]!)).toBe(true);
  });

  it('should reject a stage at depth zero', () => {
    // Depth is derived at publish time and a source is 1, so 0 means depth
    // resolution never ran - a reader grouping by depth would silently open a
    // column above the source.
    //
    // Assert
    expect(Value.Check(AUDIO_STAGE_SCHEMA, { ...STAGES[0]!, depth: 0 })).toBe(
      false,
    );
  });

  it('should reject a stage missing the levels key entirely', () => {
    // Assert - levels is a required key even though its value can be null:
    // the publisher always writes it, so a missing key means the shape
    // drifted, not that the point runs no meter.
    expect(Value.Check(AUDIO_STAGE_SCHEMA, without(STAGES[0]!, 'levels'))).toBe(
      false,
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

  it('should reject a snapshot missing the stages key entirely', () => {
    // Assert - the publisher writes stages on every publish, so a missing key
    // means the shape drifted; accepting it would render an entire session's
    // pipeline as absent rather than as unparseable.
    expect(
      Value.Check(
        SESSION_AUDIO_SNAPSHOT_SCHEMA,
        without(SESSION_AUDIO, 'stages'),
      ),
    ).toBe(false);
  });

  it('should reject the pre-stage-graph payload shape', () => {
    // The shape shipped before per-stage telemetry: levels flattened onto the
    // snapshot and one top-level vadStats. There is deliberately no
    // compatibility shim - the key's TTL bounds a rolling upgrade to one poll
    // - and that decision only holds if the old shape is rejected outright.
    // Accepted, its fields would arrive as undefined all through the
    // dashboard, which is the failure the restated schema exists to prevent.
    //
    // Arrange
    const oldShape = {
      ...LEVELS,
      vadStats: VAD_STATS,
      sessionUid: 'session-1',
      roomUid: 'room-1',
      transcriptionHost: 'gpu-1',
      updatedAt: 1_731_970_000_123,
    };

    // Assert
    expect(Value.Check(SESSION_AUDIO_SNAPSHOT_SCHEMA, oldShape)).toBe(false);
  });

  it('should reject a stats-only payload with no envelope', () => {
    // Assert - AUDIO_LEVEL_STATS_SCHEMA alone accepts just the meter fields,
    // which is what makes it reusable as a stage's levels.
    expect(Value.Check(AUDIO_LEVEL_STATS_SCHEMA, LEVELS)).toBe(true);
    expect(Value.Check(SESSION_AUDIO_SNAPSHOT_SCHEMA, LEVELS)).toBe(false);
  });
});

describe('parseSessionAudioSnapshot', () => {
  const SESSION_AUDIO = {
    stages: [
      {
        stage: 'ingress',
        label: 'Source ingress',
        depth: 1,
        inputs: [],
        levels: {
          rmsDbfs: -18.4,
          peakDbfs: -6.2,
          clippingPct: 0,
          silence: false,
          noiseFloorDbfs: -42.1,
        },
        vad: null,
        audioSeconds: 123.4,
      },
    ],
    sessionUid: 'session-1',
    roomUid: null,
    transcriptionHost: 'gpu-1',
    updatedAt: 1_731_970_000_123,
  };

  /** The failure's messages, or an empty list if it did not fail. */
  function errorsOf(result: SnapshotParseResult<unknown>): string[] {
    return result.ok ? [] : result.errors;
  }

  it('should return the snapshot for a value the publisher wrote', () => {
    // Act
    const result = parseSessionAudioSnapshot(JSON.stringify(SESSION_AUDIO));

    // Assert
    expect(result).toMatchObject({ ok: true });
    expect(result.ok && result.value.stages[0]!.stage).toBe('ingress');
  });

  it('should report malformed JSON rather than throwing', () => {
    // A truncated write, or a collision with another producer, is an expected
    // input from a shared networked key space - the caller drops the member
    // and keeps serving the rest of the fleet, which it cannot do if the
    // parse throws.
    //
    // Act
    const result = parseSessionAudioSnapshot('{"stages":');

    // Assert
    expect(result).toMatchObject({ ok: false, reason: 'malformed-json' });
    expect(errorsOf(result)).not.toHaveLength(0);
  });

  it('should report why a well-formed value of the wrong shape was rejected', () => {
    // The reason is what separates a shape drift from a key that expired
    // mid-read: both end as a dropped member, only one is a bug, and a bare
    // null tells an operator nothing about which.
    //
    // Act
    const result = parseSessionAudioSnapshot(
      JSON.stringify(without(SESSION_AUDIO, 'stages')),
    );

    // Assert
    expect(result).toMatchObject({ ok: false, reason: 'schema-mismatch' });
    expect(errorsOf(result).join('; ')).toContain('stages');
  });

  it('should reject a JSON value that is not an object at all', () => {
    // Act - valid JSON, so it gets past the parse and has to fail the schema;
    // a cast would have handed a string to every reader downstream.
    const result = parseSessionAudioSnapshot('"not a snapshot"');

    // Assert
    expect(result).toMatchObject({ ok: false, reason: 'schema-mismatch' });
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

describe('TRANSCRIPTION_HOST_SNAPSHOT_SCHEMA contextIds', () => {
  it('requires integer context ids, because the publisher emits sorted(set[int])', () => {
    // Arrange - the shape `worker_view.py` actually writes: opaque numeric ids.
    const worker = {
      workerId: 0,
      utilization: 0.5,
      liveJobCount: 1,
      totalJobsRegistered: 3,
      contextIds: [1, 2],
      alive: true,
      activeJobs: [],
      estimatedCapacitySessions: null,
    };

    // Act / Assert - integers accept.
    expect(Value.Check(TRANSCRIPTION_WORKER_SCHEMA, worker)).toBe(true);

    // Assert - context *tags* are rejected. This schema declared
    // `Type.Array(Type.String())` from the day it was written, and nothing
    // noticed for as long as the reader cast instead of validating: the
    // monitoring sidecar's hand-written restatement of the same endpoint had
    // `Type.Array(Type.Number())` all along. Turning on validation without
    // fixing this would have dropped every transcription-host snapshot and
    // blanked both the hosts and providers sections of the fleet view.
    expect(
      Value.Check(TRANSCRIPTION_WORKER_SCHEMA, {
        ...worker,
        contextIds: ['faster-whisper', 'silero'],
      }),
    ).toBe(false);
  });
});
