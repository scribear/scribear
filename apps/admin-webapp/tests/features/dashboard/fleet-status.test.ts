import { describe, expect } from 'vitest';

import type {
  FleetSnapshot,
  SessionAudioSnapshot,
  SessionSnapshot,
} from '#src/lib/admin-api';
import {
  AUDIO_THRESHOLDS,
  audioBySession,
  deriveAudioStatus,
  setProviderKey,
} from '#src/features/dashboard/fleet-status';

function buildSession(
  overrides: Partial<SessionSnapshot> = {},
): SessionSnapshot {
  return {
    sessionUid: 'session-1',
    roomUid: null,
    providerKey: 'whisper',
    sourceCount: 1,
    subscriberCount: 1,
    pendingChunkCount: 0,
    upstreamState: 'OPEN',
    upstreamRetryAttempt: 0,
    latency: [],
    updatedAt: 1_000,
    nodeInstanceId: 'node-a',
    processUid: 'proc-1',
    ...overrides,
  };
}

function buildAudio(
  overrides: Partial<SessionAudioSnapshot> = {},
): SessionAudioSnapshot {
  return {
    rmsDbfs: -23.4,
    peakDbfs: -12.1,
    clippingPct: 0,
    silence: false,
    noiseFloorDbfs: -65.0,
    updatedAt: 1_000,
    vadStats: {
      vadEnabled: true,
      speechActiveRatio: 0.42,
      segmentCount: 3,
      meanSegmentDurationSec: 1.2,
      speechToPauseRatio: 0.72,
      snrDb: 18.5,
    },
    sessionUid: 'session-1',
    roomUid: null,
    transcriptionHost: 'ts-a',
    ...overrides,
  };
}

describe('deriveAudioStatus', (it) => {
  it('returns crit when no snapshot exists and the session is OPEN (C1: no audio reaching ASR)', () => {
    const session = buildSession({ upstreamState: 'OPEN' });

    expect(deriveAudioStatus(undefined, session)).toBe('crit');
  });

  it('returns unknown when no snapshot exists and the session is not OPEN', () => {
    const session = buildSession({ upstreamState: 'IDLE' });

    expect(deriveAudioStatus(undefined, session)).toBe('unknown');
  });

  it('returns crit when silence is true', () => {
    const session = buildSession();
    const audio = buildAudio({ silence: true });

    expect(deriveAudioStatus(audio, session)).toBe('crit');
  });

  it('returns crit when clippingPct exceeds the threshold', () => {
    const session = buildSession();
    const audio = buildAudio({
      clippingPct: AUDIO_THRESHOLDS.clippingPctCrit + 0.001,
    });

    expect(deriveAudioStatus(audio, session)).toBe('crit');
  });

  it('returns warn when rmsDbfs is very low', () => {
    const session = buildSession();
    const audio = buildAudio({ rmsDbfs: AUDIO_THRESHOLDS.rmsDbfsLow - 1 });

    expect(deriveAudioStatus(audio, session)).toBe('warn');
  });

  it('returns warn when rmsDbfs is hot', () => {
    const session = buildSession();
    const audio = buildAudio({ rmsDbfs: AUDIO_THRESHOLDS.rmsDbfsHigh + 1 });

    expect(deriveAudioStatus(audio, session)).toBe('warn');
  });

  it('returns warn when VAD is enabled and snrDb is poor', () => {
    const session = buildSession();
    const audio = buildAudio({
      vadStats: {
        vadEnabled: true,
        speechActiveRatio: 0.3,
        segmentCount: 1,
        meanSegmentDurationSec: 0.5,
        speechToPauseRatio: 0.43,
        snrDb: AUDIO_THRESHOLDS.snrDbPoor - 1,
      },
    });

    expect(deriveAudioStatus(audio, session)).toBe('warn');
  });

  it('returns good when VAD is enabled and snrDb is null (not measured, not poor)', () => {
    const session = buildSession();
    const audio = buildAudio({
      vadStats: {
        vadEnabled: true,
        speechActiveRatio: 1.0,
        segmentCount: 1,
        meanSegmentDurationSec: 0.5,
        speechToPauseRatio: null,
        snrDb: null,
      },
    });

    expect(deriveAudioStatus(audio, session)).toBe('good');
  });

  it('returns good when vadStats is null (VAD not produced) and levels are fine', () => {
    const session = buildSession();
    const audio = buildAudio({ vadStats: null });

    expect(deriveAudioStatus(audio, session)).toBe('good');
  });

  it('returns good when vadEnabled is false (VAD never ran) and levels are fine', () => {
    const session = buildSession();
    const audio = buildAudio({
      vadStats: {
        vadEnabled: false,
        speechActiveRatio: null,
        segmentCount: null,
        meanSegmentDurationSec: null,
        speechToPauseRatio: null,
        snrDb: null,
      },
    });

    expect(deriveAudioStatus(audio, session)).toBe('good');
  });

  it('returns good for a healthy snapshot', () => {
    const session = buildSession();
    const audio = buildAudio();

    expect(deriveAudioStatus(audio, session)).toBe('good');
  });
});

describe('audioBySession', (it) => {
  it('returns an empty map when the snapshot is null', () => {
    expect(audioBySession(null).size).toBe(0);
  });

  it('returns an empty map when sessionAudio is empty', () => {
    const snapshot: FleetSnapshot = {
      generatedAt: 1,
      nodes: [],
      sessions: [],
      transcriptionHosts: [],
      providers: [],
      sessionAudio: [],
    };

    expect(audioBySession(snapshot).size).toBe(0);
  });

  it('indexes audio snapshots by sessionUid', () => {
    const audio1 = buildAudio({ sessionUid: 'session-a' });
    const audio2 = buildAudio({ sessionUid: 'session-b' });
    const snapshot: FleetSnapshot = {
      generatedAt: 1,
      nodes: [],
      sessions: [],
      transcriptionHosts: [],
      providers: [],
      sessionAudio: [audio1, audio2],
    };

    const map = audioBySession(snapshot);

    expect(map.get('session-a')).toEqual(audio1);
    expect(map.get('session-b')).toEqual(audio2);
    expect(map.size).toBe(2);
  });
});

describe('setProviderKey', (it) => {
  it('preserves audioStatus when clearing the provider filter', () => {
    const filter = {
      status: ['crit' as const],
      providerKey: 'whisper',
      audioStatus: ['crit' as const, 'warn' as const],
    };

    const result = setProviderKey(filter, undefined);

    expect(result.providerKey).toBeUndefined();
    expect(result.audioStatus).toEqual(['crit', 'warn']);
    expect(result.status).toEqual(['crit']);
  });

  it('preserves audioStatus when setting the provider filter', () => {
    const filter = {
      audioStatus: ['crit' as const],
    };

    const result = setProviderKey(filter, 'whisper');

    expect(result.providerKey).toBe('whisper');
    expect(result.audioStatus).toEqual(['crit']);
  });
});
