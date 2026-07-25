import { describe, expect } from 'vitest';

import {
  AUDIO_THRESHOLDS,
  audioBySession,
  deriveAudioStatus,
  deriveStageEdges,
  formatClippingPct,
  headlineStage,
  headlineVadStats,
  setProviderKey,
  signalLossEdges,
  sourceThroughputSeconds,
  stagesByDepth,
  vadStage,
} from '#src/features/dashboard/fleet-status';
import type { FleetSnapshot, SessionSnapshot } from '#src/lib/admin-api';

import {
  buildAudioSnapshot,
  buildLevels,
  buildThroughputOnlySnapshot,
  buildVadDisabled,
  buildVadStats,
  stageAsrInput,
  stageIngress,
  stageVad,
} from './audio-fixtures';

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

describe('headlineStage', (it) => {
  it('picks the lowest-depth metered stage, because that is the one that answers C1', () => {
    // Arrange — the shipped whisper graph: ingress (depth 1) and asr_input
    // (depth 2) both meter. Only the first is upstream of anything the pipeline
    // itself did to the audio, so only it can distinguish a muted mic from a
    // broken worker (§12.6, D1).
    const audio = buildAudioSnapshot();

    // Act / Assert
    expect(headlineStage(audio)?.stage).toBe('ingress');
  });

  it('skips a shallower stage that reports no levels', () => {
    // A throughput-only point at depth 1 must not shadow a real meter deeper
    // down: "lowest depth" is a tiebreak among *measurements*, not among stages.
    const audio = buildAudioSnapshot({
      stages: [stageIngress({ levels: null }), stageAsrInput(), stageVad()],
    });

    expect(headlineStage(audio)?.stage).toBe('asr_input');
  });

  it('returns undefined when nothing in the graph meters', () => {
    expect(headlineStage(buildThroughputOnlySnapshot())).toBeUndefined();
  });

  it('resolves a tie at the same depth deterministically, whatever order the publisher serialised', () => {
    // Two metering sources at depth 1 are two equally valid answers to C1;
    // picking a stable one keeps the card, the chip and the detail page from
    // describing different stages between two polls of unchanged data.
    const a = stageIngress({ stage: 'ingress_a', label: 'Room A' });
    const b = stageIngress({ stage: 'ingress_b', label: 'Room B' });

    expect(headlineStage(buildAudioSnapshot({ stages: [a, b] }))?.stage).toBe(
      'ingress_a',
    );
    expect(headlineStage(buildAudioSnapshot({ stages: [b, a] }))?.stage).toBe(
      'ingress_a',
    );
  });
});

describe('vadStage and headlineVadStats', (it) => {
  it('reads the VAD of whichever stage carries one, not the headline stage', () => {
    // §12.6. The two are never the same point in the shipped graph: the meters
    // carry no detector and the detector carries no levels.
    const audio = buildAudioSnapshot();

    expect(vadStage(audio)?.stage).toBe('vad');
    expect(headlineVadStats(audio)?.speechActiveRatio).toBe(0.42);
  });

  it('returns null when no stage runs a detector', () => {
    // Only whisper reports a `vad` stage (§12.3), so this is the common case,
    // and it must stay distinct from `vadEnabled: false`.
    const audio = buildAudioSnapshot({
      stages: [stageIngress(), stageAsrInput()],
    });

    expect(vadStage(audio)).toBeUndefined();
    expect(headlineVadStats(audio)).toBeNull();
  });
});

describe('stagesByDepth', (it) => {
  it('groups and orders by depth regardless of the order on the wire', () => {
    // A table whose rows reorder between two polls of an unchanged pipeline is
    // unreadable, and array order is not part of the contract.
    const audio = buildAudioSnapshot({
      stages: [stageVad(), stageIngress(), stageAsrInput()],
    });

    expect(stagesByDepth(audio).map((g) => g.depth)).toEqual([1, 2, 3]);
    expect(stagesByDepth(audio)[0]?.stages[0]?.stage).toBe('ingress');
  });

  it('puts several stages at one depth in the same group', () => {
    const audio = buildAudioSnapshot({
      stages: [
        stageIngress({ stage: 'ingress_b' }),
        stageIngress({ stage: 'ingress_a' }),
      ],
    });
    const groups = stagesByDepth(audio);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.stages.map((s) => s.stage)).toEqual([
      'ingress_a',
      'ingress_b',
    ]);
  });
});

describe('sourceThroughputSeconds', (it) => {
  it('reports the most source-proximate counter, not the largest number', () => {
    // A deeper stage's total is downstream of any loss, so it understates what
    // arrived; the card's "metering unavailable" copy needs what arrived.
    expect(sourceThroughputSeconds(buildAudioSnapshot())).toBe(123.4);
  });

  it('returns null when no stage counts seconds', () => {
    const audio = buildAudioSnapshot({
      stages: [stageIngress({ audioSeconds: null })],
    });

    expect(sourceThroughputSeconds(audio)).toBeNull();
  });
});

describe('deriveStageEdges', (it) => {
  it('does not flag the normal standing skew between two counters', () => {
    // The whole reason the tolerance exists: ingress is sampled on the webserver
    // at publish time while a worker's counter only advances when a job runs, so
    // a healthy session always shows a small positive difference. A naive `> 0`
    // check would report loss on every session in the fleet.
    const audio = buildAudioSnapshot();

    const edge = deriveStageEdges(audio).find((e) => e.toStage === 'asr_input');

    expect(edge?.differenceSeconds).toBeCloseTo(0.5, 5);
    expect(edge?.kind).toBe('within-tolerance');
    expect(signalLossEdges(audio)).toHaveLength(0);
  });

  it('does not flag a difference exactly at the tolerance', () => {
    // The comparison is strict (`>`), so the tolerance value itself is still
    // normal. Pinned because an off-by-one here flags a whole fleet at once.
    const audio = buildAudioSnapshot({
      stages: [
        stageIngress({ audioSeconds: 100 }),
        stageAsrInput({
          audioSeconds: 100 - AUDIO_THRESHOLDS.signalLossToleranceSec,
        }),
      ],
    });

    expect(signalLossEdges(audio)).toHaveLength(0);
  });

  it('flags loss past the tolerance and attributes it to the edge that lost it', () => {
    // The derivation the stage graph exists for: not "audio is bad" but "audio
    // went missing between these two points" (§12.6).
    const audio = buildAudioSnapshot({
      stages: [
        stageIngress({ audioSeconds: 120 }),
        stageAsrInput({ audioSeconds: 100 }),
        stageVad({ audioSeconds: 40 }),
      ],
    });

    const lost = signalLossEdges(audio);

    expect(lost).toHaveLength(1);
    expect(lost[0]?.fromStage).toBe('ingress');
    expect(lost[0]?.toStage).toBe('asr_input');
    expect(lost[0]?.differenceSeconds).toBeCloseTo(20, 5);
  });

  it('calls the drop across a detector gating, not loss', () => {
    // A VAD is *supposed* to pass on less than it received — the shipped graph
    // passes ~47 s of speech out of ~123 s of audio. Charging that as loss would
    // put a large red number on every VAD-enabled session, which is the same
    // class of false alarm §12.1 exists to remove.
    const audio = buildAudioSnapshot();

    const edge = deriveStageEdges(audio).find((e) => e.toStage === 'vad');

    expect(edge?.kind).toBe('gated');
    expect(edge?.differenceSeconds).toBeCloseTo(75.7, 5);
    expect(signalLossEdges(audio)).toHaveLength(0);
  });

  it('omits an edge when either end does not count seconds', () => {
    // An undefined subtraction rendered as "0 s lost" would be a claim the data
    // does not support, so the edge is simply not derivable.
    const audio = buildAudioSnapshot({
      stages: [
        stageIngress({ audioSeconds: null }),
        stageAsrInput({ audioSeconds: 100 }),
      ],
    });

    expect(deriveStageEdges(audio)).toHaveLength(0);
  });

  it('drops an input naming a stage that is absent from the snapshot', () => {
    // §12.2 allows it: that upstream point reported nothing this batch. An
    // incomplete graph is not a fatal one.
    const audio = buildAudioSnapshot({
      stages: [stageAsrInput({ inputs: ['ingress'] })],
    });

    expect(deriveStageEdges(audio)).toHaveLength(0);
  });

  it('treats a downstream counter that is ahead of its input as normal, not as loss', () => {
    // Negative differences are meaningless rather than alarming — the two
    // counters do not share a clock.
    const audio = buildAudioSnapshot({
      stages: [
        stageIngress({ audioSeconds: 100 }),
        stageAsrInput({ audioSeconds: 130 }),
      ],
    });

    expect(deriveStageEdges(audio)[0]?.kind).toBe('within-tolerance');
  });

  it('reports both edges of a stage with two inputs', () => {
    // Attribution to a specific edge is why `inputs` is on the wire at all: a
    // bare depth integer could not say which upstream point fed which.
    const audio = buildAudioSnapshot({
      stages: [
        stageIngress({ stage: 'ingress_a', audioSeconds: 100 }),
        stageIngress({ stage: 'ingress_b', audioSeconds: 100 }),
        stageAsrInput({
          inputs: ['ingress_a', 'ingress_b'],
          audioSeconds: 60,
        }),
      ],
    });

    const lost = signalLossEdges(audio);

    expect(lost.map((e) => e.fromStage)).toEqual(['ingress_a', 'ingress_b']);
  });
});

describe('deriveAudioStatus', (it) => {
  it('returns crit when no snapshot exists and the session is OPEN (C1: no audio reaching ASR)', () => {
    const session = buildSession({ upstreamState: 'OPEN' });

    expect(deriveAudioStatus(undefined, session)).toBe('crit');
  });

  it('returns unknown when no snapshot exists and the session is not OPEN', () => {
    const session = buildSession({ upstreamState: 'IDLE' });

    expect(deriveAudioStatus(undefined, session)).toBe('unknown');
  });

  it('returns unknown — not good, not crit — for a snapshot whose stages report no levels', () => {
    // The state §12.1 created: the `debug` provider counts throughput and meters
    // nothing. `good` would be a false green asserted from zero measurements
    // (and would hide a genuinely broken room); `crit` would be the false fault
    // §12 was written to remove, on a session that is demonstrably publishing.
    // `unknown` is the only status that says what is true: no reading.
    const session = buildSession({ upstreamState: 'OPEN' });

    expect(deriveAudioStatus(buildThroughputOnlySnapshot(), session)).toBe(
      'unknown',
    );
  });

  it('returns unknown for a snapshot with no stages at all', () => {
    // Nothing has measured anything yet. Same reasoning; an empty graph is a
    // real state, not a malformed payload.
    const session = buildSession();

    expect(deriveAudioStatus(buildAudioSnapshot({ stages: [] }), session)).toBe(
      'unknown',
    );
  });

  it('returns crit when silence is true', () => {
    const session = buildSession();
    const audio = buildAudioSnapshot({
      stages: [stageIngress({ levels: buildLevels({ silence: true }) })],
    });

    expect(deriveAudioStatus(audio, session)).toBe('crit');
  });

  it('returns crit when clippingPct exceeds the threshold', () => {
    const session = buildSession();
    const audio = buildAudioSnapshot({
      stages: [
        stageIngress({
          levels: buildLevels({
            clippingPct: AUDIO_THRESHOLDS.clippingPctCrit + 0.001,
          }),
        }),
      ],
    });

    expect(deriveAudioStatus(audio, session)).toBe('crit');
  });

  it('classifies on the headline stage, ignoring a deeper stage that reads badly', () => {
    // §12.8 point 1 as an assertion: the audio axis answers "is the source
    // sending good audio". A clipped ASR input behind a clean ingress is a
    // pipeline fault, and folding it in here would recreate the confusion D1
    // separated the two axes to avoid.
    const session = buildSession();
    const audio = buildAudioSnapshot({
      stages: [
        stageIngress(),
        stageAsrInput({ levels: buildLevels({ clippingPct: 0.5 }) }),
      ],
    });

    expect(deriveAudioStatus(audio, session)).toBe('good');
  });

  it('returns warn when rmsDbfs is very low', () => {
    const session = buildSession();
    const audio = buildAudioSnapshot({
      stages: [
        stageIngress({
          levels: buildLevels({ rmsDbfs: AUDIO_THRESHOLDS.rmsDbfsLow - 1 }),
        }),
      ],
    });

    expect(deriveAudioStatus(audio, session)).toBe('warn');
  });

  it('returns warn when rmsDbfs is hot', () => {
    const session = buildSession();
    const audio = buildAudioSnapshot({
      stages: [
        stageIngress({
          levels: buildLevels({ rmsDbfs: AUDIO_THRESHOLDS.rmsDbfsHigh + 1 }),
        }),
      ],
    });

    expect(deriveAudioStatus(audio, session)).toBe('warn');
  });

  it('returns warn when VAD is enabled and snrDb is poor', () => {
    // The VAD reading comes from the detector stage, not the headline stage —
    // the two are different points and the status needs both.
    const session = buildSession();
    const audio = buildAudioSnapshot({
      stages: [
        stageIngress(),
        stageVad({
          vad: buildVadStats({ snrDb: AUDIO_THRESHOLDS.snrDbPoor - 1 }),
        }),
      ],
    });

    expect(deriveAudioStatus(audio, session)).toBe('warn');
  });

  it('returns good when VAD is enabled and snrDb is null (not measured, not poor)', () => {
    const session = buildSession();
    const audio = buildAudioSnapshot({
      stages: [
        stageIngress(),
        stageVad({
          vad: buildVadStats({
            speechActiveRatio: 1.0,
            speechToPauseRatio: null,
            snrDb: null,
          }),
        }),
      ],
    });

    expect(deriveAudioStatus(audio, session)).toBe('good');
  });

  it('returns good when no stage runs a detector and levels are fine', () => {
    const session = buildSession();
    const audio = buildAudioSnapshot({
      stages: [stageIngress(), stageAsrInput()],
    });

    expect(deriveAudioStatus(audio, session)).toBe('good');
  });

  it('returns good when vadEnabled is false (VAD never ran) and levels are fine', () => {
    const session = buildSession();
    const audio = buildAudioSnapshot({
      stages: [stageIngress(), stageVad({ vad: buildVadDisabled() })],
    });

    expect(deriveAudioStatus(audio, session)).toBe('good');
  });

  it('returns good for a healthy snapshot', () => {
    const session = buildSession();

    expect(deriveAudioStatus(buildAudioSnapshot(), session)).toBe('good');
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
    const audio1 = buildAudioSnapshot({ sessionUid: 'session-a' });
    const audio2 = buildAudioSnapshot({ sessionUid: 'session-b' });
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

describe('formatClippingPct', (it) => {
  // `clippingPct` is a FRACTION (0..1) — the share of the window at the rail in
  // runs, per audio_meter.py — so rendering it with a bare `%` suffix
  // understates clipping by 100x. These pin the units for both surfaces.
  it('scales the fraction to a percentage', () => {
    expect(formatClippingPct(0.05)).toBe('5.00%');
  });

  it('renders the crit threshold as 1%, not 0.01%', () => {
    expect(formatClippingPct(AUDIO_THRESHOLDS.clippingPctCrit)).toBe('1.00%');
  });

  it('renders full clipping as 100%', () => {
    expect(formatClippingPct(1)).toBe('100.00%');
  });

  it('never claims 0.00% for a nonzero fraction', () => {
    // The chip is only shown when clippingPct > 0, so rounding a small but real
    // value to "0.00%" would contradict the reason it is on screen.
    expect(formatClippingPct(0.000005)).toBe('<0.01%');
  });

  it('renders an exact zero as 0.00%', () => {
    expect(formatClippingPct(0)).toBe('0.00%');
  });
});
