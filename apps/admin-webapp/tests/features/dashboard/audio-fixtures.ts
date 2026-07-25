import type {
  AudioLevelStats,
  AudioStage,
  SessionAudioSnapshot,
  VadStats,
} from '#src/lib/admin-api';

/**
 * Stage-graph fixtures shared by every audio suite (§12.2/§12.3 of
 * PLAN-AUDIOVIZ).
 *
 * Shared rather than copied per file for the same reason `headlineStage` is one
 * exported helper: four suites each inventing their own idea of what a published
 * graph looks like is four chances to test a shape the publisher never emits. The
 * defaults here are the shipped whisper graph from §12.3 — `ingress` and
 * `asr_input` meter, `vad` gates and counts speech seconds only — and the
 * `audioSeconds` figures are §12.4's example payload, so the default snapshot is
 * a healthy session with a normal (sub-tolerance) ingress→asr_input skew.
 */

export function buildLevels(
  overrides: Partial<AudioLevelStats> = {},
): AudioLevelStats {
  return {
    rmsDbfs: -23.4,
    peakDbfs: -12.1,
    clippingPct: 0,
    silence: false,
    noiseFloorDbfs: -65.0,
    ...overrides,
  };
}

export function buildVadStats(overrides: Partial<VadStats> = {}): VadStats {
  return {
    vadEnabled: true,
    speechActiveRatio: 0.42,
    segmentCount: 3,
    meanSegmentDurationSec: 1.2,
    speechToPauseRatio: 0.72,
    snrDb: 18.5,
    ...overrides,
  };
}

/** VAD as it reports when a detector exists for the stage but never ran — every
 *  field null, which §6.2 forbids rendering as `0`. */
export function buildVadDisabled(): VadStats {
  return {
    vadEnabled: false,
    speechActiveRatio: null,
    segmentCount: null,
    meanSegmentDurationSec: null,
    speechToPauseRatio: null,
    snrDb: null,
  };
}

/** Depth 1, meters, counts seconds received on the websocket. Reported by the
 *  stream controller for **every** provider — the point of §12. */
export function stageIngress(overrides: Partial<AudioStage> = {}): AudioStage {
  return {
    stage: 'ingress',
    label: 'Source ingress',
    depth: 1,
    inputs: [],
    levels: buildLevels(),
    vad: null,
    audioSeconds: 123.4,
    ...overrides,
  };
}

/** Depth 2, meters (except on `debug`), counts seconds decoded into the ASR
 *  buffer. 0.5 s behind ingress by default — a normal standing skew. */
export function stageAsrInput(overrides: Partial<AudioStage> = {}): AudioStage {
  return {
    stage: 'asr_input',
    label: 'ASR input (worker decode)',
    depth: 2,
    inputs: ['ingress'],
    levels: buildLevels(),
    vad: null,
    audioSeconds: 122.9,
    ...overrides,
  };
}

/** Depth 3, whisper only: no levels, a detector, and cumulative *speech*
 *  seconds — legitimately far below its input's total. */
export function stageVad(overrides: Partial<AudioStage> = {}): AudioStage {
  return {
    stage: 'vad',
    label: 'VAD (Silero)',
    depth: 3,
    inputs: ['asr_input'],
    levels: null,
    vad: buildVadStats(),
    audioSeconds: 47.2,
    ...overrides,
  };
}

/**
 * A published snapshot. Defaults to the full whisper graph; pass `stages` to
 * build another provider's shape (`debug` is a single `asr_input` with
 * `levels: null`, per §12.3).
 */
export function buildAudioSnapshot(
  overrides: Partial<SessionAudioSnapshot> = {},
): SessionAudioSnapshot {
  return {
    updatedAt: 1_000,
    stages: [stageIngress(), stageAsrInput(), stageVad()],
    sessionUid: 'session-1',
    roomUid: null,
    transcriptionHost: 'ts-a',
    ...overrides,
  };
}

/**
 * The `debug` provider's snapshot: one measurement point, throughput only.
 *
 * The state §12.1 was written about — this provider published nothing at all
 * before the reshape, so every healthy session on it showed a red audio chip.
 * It must now classify as `unknown`, not `good` and not `crit`.
 */
export function buildThroughputOnlySnapshot(
  overrides: Partial<SessionAudioSnapshot> = {},
): SessionAudioSnapshot {
  return buildAudioSnapshot({
    stages: [
      stageAsrInput({
        label: 'ASR input (debug decode)',
        levels: null,
        inputs: [],
        depth: 1,
        audioSeconds: 33.6,
      }),
    ],
    ...overrides,
  });
}
