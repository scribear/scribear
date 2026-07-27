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
 * The captions are the point of this file. §2.2 was a table of claims about what
 * each fault was *expected* to show up as, and the plan was explicit that the
 * table must not be taken on faith. Rendering the claim beside the knob that
 * makes it is what turns "the operator has to go and read the plan" into "the
 * operator can see what to go and look at", and what makes a wrong entry
 * visible the first time someone turns the knob.
 *
 * **The fault captions are now measurements, not predictions.** Every one was
 * taken against a live GPU stack (`cuda128`, RTX 5070 Ti, `faster-whisper`
 * `turbo`, one device at a time, 120 s per knob) — the raw numbers, the exact
 * alert text and the baseline they are differences from are in
 * `MEASURED-TestAudio-Faults.md`. Four of the nine original claims were wrong or
 * half right, and those captions now say what actually happens instead. Two
 * things a reader should carry: the numbers are hardware-dependent where the
 * caption says so, and a knob whose caption says "nothing moves" is reporting a
 * measured absence, not an untested guess.
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
  /** What turning this knob up **was measured to do**, named concretely enough
   *  to go and look at. See `MEASURED-TestAudio-Faults.md` for the run each
   *  number comes from. */
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
      "Measured: the ingress meter's clippingPct reads back the knob almost exactly — 50% here gave clippingPct 0.5002, with RMS up 24.9 dB, peak on the rail at 0.00 dBFS and VAD snrDb collapsing 17.5 → 0.03. No alert rule watches clipping, so the reading itself is the signal. Side effect worth knowing: the distortion raises the ASR duty ratio to ~0.54 and trips the asr-falling-behind WARNING on a GPU stack.",
  },
  {
    key: 'stutterPct',
    label: 'Repeated frames (stutter)',
    min: 0,
    max: 100,
    step: 1,
    unit: '%',
    caption:
      "Measured: nothing moves. At 50% (404 duplicated frames in 120 s) every counter stayed flat — decode drops, pending-chunk evictions, unmatched chunks, repeated_segment_detected_total — and the transcript count matched the clean baseline exactly. Duplicate chunk ids are silently overwritten in node-server, and the canary-repetition WARNING scores the monitoring canary's own run in its own room, so this device cannot reach it. The only effect you can see is the captions garbling. Use it to reproduce a garbled transcript, not to trip an alert.",
  },
  {
    key: 'dropPct',
    label: 'Dropped frames',
    min: 0,
    max: 100,
    step: 1,
    unit: '%',
    caption:
      'Measured: the gap is real — 50% halved asr_audio_seconds_total (119.6 → 58.7 s) — but VAD does not notice it. vad_no_speech_total and speechActiveRatio were unchanged from the clean baseline: a dropped frame is absent, not silent, so VAD never sees the hole. What does move is the ingress noise floor (+10.8 dB) and snrDb (−13.3 dB), because splicing removes the quiet gaps the floor estimate is made of, plus the low-confidence guards firing 5–6× as often. Halving the audio also doubles the duty ratio, which trips the asr-falling-behind WARNING.',
  },
  {
    key: 'speedup',
    label: 'Send-rate multiple',
    min: 1,
    max: 3,
    step: 0.1,
    unit: '×',
    caption:
      'Measured: on a GPU this knob trips nothing, at any setting it offers. 2.0× and 3.0× both ran the full two minutes and produced captions to the last frame, with scribear_asr_audio_too_fast_total flat at zero and no alert. "Client sent audio too quickly" is raised only when the 30-second buffer overflows, so this measures the transcription service\'s spare headroom rather than the send rate — at RTF ~0.35 it keeps up even at 2.96× realtime. Expect it to fire on CPU hardware, where RTF is around 0.47 at 1× (untested).',
  },
  {
    key: 'silencePct',
    label: 'Digital silence',
    min: 0,
    max: 100,
    step: 1,
    unit: '%',
    caption:
      'Measured: the loudest of the nine. At 100% the ingress meter reads silence: true with RMS, peak and noise floor all pinned at −120 dBFS, speechActiveRatio 0.0 and no VAD segments; vad_no_speech_total and no_words_total move on every single job (+239 in 120 s against +34 on clean audio). It also fires the asr-buffer-overflow WARNING — 180 buffers force-finalized in two minutes, because a buffer with no speech in it is never finalized normally.',
  },
  {
    key: 'dcOffset',
    label: 'DC bias',
    min: 0,
    max: 1,
    step: 0.01,
    unit: ' of full scale',
    caption:
      'Measured: no surface reports DC, confirmed on a live stack — not AudioLevelStats, not the standalone meter, not node-server status. A bias of 0.5 of full scale showed up only as inflated level: RMS +20.7 dB, peak +7.8 dB, noise floor +35.6 dB, with clippingPct still 0.0000 (half scale does not reach the rail) and the captions unharmed. No alert fires. Use it to move the level meters without touching the speech.',
  },
  {
    key: 'corruptPct',
    label: 'Corrupt frames (bad CRC / truncated)',
    min: 0,
    max: 100,
    step: 1,
    unit: '%',
    caption:
      'Measured: exact. 20% corrupted 230 of 1200 frames and node-server\'s decode-drop counter moved by exactly 230, surfacing as scribear_safp_decode_drops_total and firing the safp-decode-drops WARNING (failure modes U2/S4) — "230 malformed SAFP frames dropped in 120s". The version-skew signature, reproduced on demand. The transcription service\'s own decode_drops_total stays at zero: node-server rejects the frame first, so its defence-in-depth decoder never sees one.',
  },
  {
    key: 'badHeaderPct',
    label: 'Wrong-sample-rate WAV header',
    min: 0,
    max: 100,
    step: 1,
    unit: '%',
    caption:
      'Measured: the most destructive of the nine, and not a "decode rejection" — no decode counter moves anywhere. A wrong-rate WAV raises Sample rate mismatch inside the whisper job, which closes the upstream socket 1007; node-server reconnects and the next bad frame kills it again. At 50% that was 8 reconnects in 120 s, the upstream-churn CRITICAL, and zero captions for the entire run (asr_audio_seconds_total moved 1.4 s). Turn this one on knowing it takes the session out, not just a frame.',
  },
  {
    key: 'clockSkewMs',
    label: 'Clock skew written into sentAt',
    min: -5000,
    max: 5000,
    step: 100,
    unit: ' ms',
    caption:
      'Measured: exact. +5000 ms put 175 of 189 latency samples negative in 120 s and fired the clock-skew WARNING (S5) — "93% of latency samples had a negative end-to-end time (175/189)". The rule needs 20 samples with 20% negative, so a skew larger than the ~2.6 s baseline end-to-end latency trips it within one window. Pipeline latency and the captions are unaffected — only the measurement breaks.',
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
