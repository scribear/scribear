import type {
  TestAudioClip,
  TestAudioFaultParams,
  TestAudioGoodParams,
  TestAudioNoiseDb,
  TestAudioNoiseType,
} from '#src/lib/admin-api';

/**
 * Ranges, defaults and captions for the two synthetic sources
 * (`PLAN-TestAudioDevices.md` §2.1 and §2.2).
 *
 * The captions are the point of this file. §2.2 is a table of claims about what
 * each fault is *expected* to show up as, and the plan is explicit that the
 * table must not be taken on faith. Rendering the claim beside the knob that
 * makes it is what turns "the operator has to go and read the plan" into "the
 * operator can see what to go and look at", and what makes a wrong entry
 * visible the first time someone turns the knob.
 *
 * Every identifier named below was checked against the source at time of
 * writing: `apps/monitoring-sidecar/src/server/shared/alerts/alert-rules.ts`
 * (alert ids and severities), that app's `metrics-registry.service.ts` (metric
 * names, which all carry a `scribear_` prefix the plan's table omits), and
 * `AudioLevelStats` / `VadStats` in `#src/lib/admin-api` for the telemetry
 * fields. Where §2.2's claim is not backed by anything that exists, the caption
 * says so rather than repeating it.
 */

// ---- Run duration (§2: required on start, capped, auto-stops at expiry) ----

export const DURATION_MIN_SEC = 10;
/** `TEST_AUDIO_MAX_DURATION_SEC`'s documented default. The server caps
 *  independently — this only keeps the field from offering an impossible run. */
export const DURATION_MAX_SEC = 1800;
export const DEFAULT_DURATION_SEC = 300;

// ---- Device 1: good source (§2.1) ----

export const CLIP_OPTIONS: { value: TestAudioClip; label: string }[] = [
  { value: 'harvard', label: 'Harvard sentences (33.6 s)' },
  { value: 'apollo', label: 'Apollo (50 s)' },
  { value: 'longform', label: 'Longform (~5 min, built at image build)' },
];

export const GAIN_DB_MIN = -40;
export const GAIN_DB_MAX = 20;
export const GAIN_DB_STEP = 1;

/** Both ends are meant to be reachable — that is the parameter's purpose. */
export const GAIN_DB_MIN_LABEL = '−40 dB (below the silence floor)';
export const GAIN_DB_MAX_LABEL = '+20 dB (hard clipping)';

export const NOISE_TYPE_OPTIONS: {
  value: TestAudioNoiseType;
  label: string;
}[] = [
  { value: 'none', label: 'None' },
  { value: 'white', label: 'White' },
  { value: 'brown', label: 'Brown' },
];

/** Five fixed levels rather than a slider, per §2.1. Loudest first so the list
 *  reads worst-to-best, the way the operator thinks about it. */
export const NOISE_DB_OPTIONS: { value: TestAudioNoiseDb; label: string }[] = [
  { value: -20, label: '−20 dBFS — loud enough to cost words' },
  { value: -30, label: '−30 dBFS' },
  { value: -40, label: '−40 dBFS' },
  { value: -50, label: '−50 dBFS' },
  { value: -60, label: '−60 dBFS — clean studio floor' },
];

export const DEFAULT_GOOD_PARAMS: TestAudioGoodParams = {
  clip: 'harvard',
  gainDb: 0,
  noiseType: 'none',
  noiseDb: -60,
};

// ---- Device 2: fault source (§2.2) ----

export interface FaultKnob {
  key: keyof TestAudioFaultParams;
  label: string;
  min: number;
  max: number;
  step: number;
  /** Appended to the value in the accessible value text and the readout. */
  unit: string;
  /** What turning this knob up is expected to show up as, named concretely
   *  enough to go and look at. */
  caption: string;
}

export const FAULT_KNOBS: FaultKnob[] = [
  {
    key: 'clipPct',
    label: 'Hard clipping',
    min: 0,
    max: 100,
    step: 1,
    unit: '%',
    caption:
      "Expected to trip: the ingress meter's clippingPct — the fraction of samples at full scale in runs of at least two — on the session's audio strip and on the standalone meter. No alert rule watches clipping, so the reading itself is the signal.",
  },
  {
    key: 'stutterPct',
    label: 'Repeated frames (stutter)',
    min: 0,
    max: 100,
    step: 1,
    unit: '%',
    caption:
      'Expected to trip: caption repetition, scored by the canary-repetition WARNING. §2.2 predicts duplicate chunk ids as well; node-server neither counts nor de-duplicates them today, so repetition in the transcript is the only observable.',
  },
  {
    key: 'dropPct',
    label: 'Dropped frames',
    min: 0,
    max: 100,
    step: 1,
    unit: '%',
    caption:
      "Expected to trip: gaps in the audio — VAD's speechActiveRatio falls and the transcription service's vad_no_speech counter moves. Visible in the session's audio telemetry; no alert fires on it.",
  },
  {
    key: 'speedup',
    label: 'Send-rate multiple',
    min: 1,
    max: 3,
    step: 0.1,
    unit: '×',
    caption:
      'Expected to trip: scribear_asr_audio_too_fast_total and the asr-audio-too-fast CRITICAL. The source is disconnected with close code 1007, so the run ends when this fires — that is the alert working, not the device failing.',
  },
  {
    key: 'silencePct',
    label: 'Digital silence',
    min: 0,
    max: 100,
    step: 1,
    unit: '%',
    caption:
      "Expected to trip: the ingress meter's silence flag and noise-floor readout, and the transcription service's vad_no_speech counter.",
  },
  {
    key: 'dcOffset',
    label: 'DC bias',
    min: 0,
    max: 1,
    step: 0.01,
    unit: ' of full scale',
    caption:
      'Expected to trip: nothing directly. §2.2 predicts "meter DC/level telemetry", but no surface measures DC — not AudioLevelStats, not the standalone meter. A bias reads as raised RMS and lost headroom, so treat this knob as unverified until §7.4 says otherwise.',
  },
  {
    key: 'corruptPct',
    label: 'Corrupt frames (bad CRC / truncated)',
    min: 0,
    max: 100,
    step: 1,
    unit: '%',
    caption:
      'Expected to trip: scribear_safp_decode_drops_total and the safp-decode-drops WARNING (failure modes U2/S4) — the version-skew signature, reproduced on demand.',
  },
  {
    key: 'badHeaderPct',
    label: 'Wrong-sample-rate WAV header',
    min: 0,
    max: 100,
    step: 1,
    unit: '%',
    caption:
      "Expected to trip: transcription-service decode rejection. Every frame's payload is a complete 44-byte-header WAV that soundfile opens and validates, so a wrong rate is rejected there — not at node-server's SAFP decoder, which sees a well-formed frame.",
  },
  {
    key: 'clockSkewMs',
    label: 'Clock skew written into sentAt',
    min: -5000,
    max: 5000,
    step: 100,
    unit: ' ms',
    caption:
      'Expected to trip: negative end-to-end latency (latencyE2eNegativeTotal) and the clock-skew WARNING (S5), which needs at least 20 latency samples with 20% of them negative before it fires. Pipeline latency is unaffected — only the measurement breaks.',
  },
];

export const DEFAULT_FAULT_PARAMS: TestAudioFaultParams = {
  clipPct: 0,
  stutterPct: 0,
  dropPct: 0,
  speedup: 1,
  silencePct: 0,
  dcOffset: 0,
  corruptPct: 0,
  badHeaderPct: 0,
  clockSkewMs: 0,
};

/** Slider steps are floats for `speedup` and `dcOffset`, so a raw value can be
 *  0.30000000000000004. Formats to the knob's own precision. */
export function formatKnobValue(knob: FaultKnob, value: number): string {
  const decimals = String(knob.step).split('.')[1]?.length ?? 0;
  return `${value.toFixed(decimals)}${knob.unit}`;
}
