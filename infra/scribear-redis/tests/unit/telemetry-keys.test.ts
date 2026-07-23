import { describe, expect, it } from 'vitest';

import {
  AUDIO_STATS_MIN_PUBLISH_INTERVAL_MS,
  AUDIO_STATS_TTL_MS,
  FLEET_EVENTS_CHANNEL_KEY,
  NODE_HEARTBEAT_MS,
  NODE_INDEX_KEY,
  NODE_TTL_MS,
  SESSION_INDEX_KEY,
  TELEMETRY_NAMESPACE,
  TRANSCRIPTION_HOST_HEARTBEAT_MS,
  TRANSCRIPTION_HOST_INDEX_KEY,
  TRANSCRIPTION_HOST_TTL_MS,
  TRANSCRIPTION_SESSION_AUDIO_INDEX_KEY,
  nodeSnapshotKey,
  sessionRouteKey,
  sessionSnapshotKey,
  transcriptionHostSnapshotKey,
  transcriptionSessionAudioKey,
} from '#src/index.js';

/** Every key family, with a representative key for the parameterised ones. */
const ALL_KEYS = [
  NODE_INDEX_KEY,
  SESSION_INDEX_KEY,
  TRANSCRIPTION_HOST_INDEX_KEY,
  TRANSCRIPTION_SESSION_AUDIO_INDEX_KEY,
  FLEET_EVENTS_CHANNEL_KEY,
  nodeSnapshotKey('node-a'),
  sessionSnapshotKey('a4f1'),
  sessionRouteKey('a4f1'),
  transcriptionHostSnapshotKey('gpu-1'),
  transcriptionSessionAudioKey('a4f1'),
];

describe('telemetry key layout', () => {
  it('should namespace every key', () => {
    // Assert
    for (const key of ALL_KEYS) {
      expect(key.startsWith(`${TELEMETRY_NAMESPACE}:`)).toBe(true);
    }
  });

  it('should give every key family a distinct name', () => {
    // Assert
    expect(new Set(ALL_KEYS).size).toBe(ALL_KEYS.length);
  });

  it('should keep no snapshot glob able to match another family', () => {
    // The families are close enough to collide by accident: `session:` and
    // `sessions:index` differ by one character. A glob that reached across
    // them would enumerate - or delete - an index along with the snapshots it
    // points at, and nothing would say so until a sweep ran in production.
    // Prefixes are derived from the builders rather than written out again, so
    // renaming a family here cannot leave this test asserting the old name.
    //
    // Arrange
    const snapshotPrefixes = [
      nodeSnapshotKey(''),
      sessionSnapshotKey(''),
      sessionRouteKey(''),
      transcriptionHostSnapshotKey(''),
      transcriptionSessionAudioKey(''),
    ];
    const indexKeys = [
      NODE_INDEX_KEY,
      SESSION_INDEX_KEY,
      TRANSCRIPTION_HOST_INDEX_KEY,
      TRANSCRIPTION_SESSION_AUDIO_INDEX_KEY,
    ];

    // Assert
    for (const prefix of snapshotPrefixes) {
      const otherKeys = [
        ...indexKeys,
        ...snapshotPrefixes.filter((other) => other !== prefix),
      ];
      expect(otherKeys.some((key) => key.startsWith(prefix))).toBe(false);
    }
  });

  it('should key snapshots by identity', () => {
    // Assert
    expect(sessionSnapshotKey('one')).not.toBe(sessionSnapshotKey('two'));
    expect(nodeSnapshotKey('one')).not.toBe(nodeSnapshotKey('two'));
    expect(transcriptionHostSnapshotKey('one')).not.toBe(
      transcriptionHostSnapshotKey('two'),
    );
    expect(transcriptionSessionAudioKey('one')).not.toBe(
      transcriptionSessionAudioKey('two'),
    );
  });

  it('should keep a session’s route separate from its snapshot', () => {
    // Assert
    expect(sessionRouteKey('a4f1')).not.toBe(sessionSnapshotKey('a4f1'));
  });
});

describe('telemetry timing', () => {
  it('should outlive several heartbeats with every ttl', () => {
    // A ttl shorter than its heartbeat expires every snapshot between writes,
    // which reads as an empty fleet rather than as a misconfiguration. The
    // margin is what absorbs a missed beat.
    //
    // Assert
    expect(NODE_TTL_MS / NODE_HEARTBEAT_MS).toBeGreaterThanOrEqual(3);
    expect(
      TRANSCRIPTION_HOST_TTL_MS / TRANSCRIPTION_HOST_HEARTBEAT_MS,
    ).toBeGreaterThanOrEqual(3);
    expect(
      AUDIO_STATS_TTL_MS / AUDIO_STATS_MIN_PUBLISH_INTERVAL_MS,
    ).toBeGreaterThanOrEqual(3);
  });

  it('should keep every interval positive', () => {
    // Assert
    for (const ms of [
      NODE_HEARTBEAT_MS,
      NODE_TTL_MS,
      TRANSCRIPTION_HOST_HEARTBEAT_MS,
      TRANSCRIPTION_HOST_TTL_MS,
      AUDIO_STATS_MIN_PUBLISH_INTERVAL_MS,
      AUDIO_STATS_TTL_MS,
    ]) {
      expect(ms).toBeGreaterThan(0);
    }
  });
});
