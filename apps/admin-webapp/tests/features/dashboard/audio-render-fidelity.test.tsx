import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { AudioMeterBar } from '#src/features/dashboard/audio-meter-bar';
import {
  AUDIO_THRESHOLDS,
  classifyAudioSnapshot,
  formatClippingPct,
  headlineStage,
} from '#src/features/dashboard/fleet-status';
import type { AudioLevelStats, SessionAudioSnapshot } from '#src/lib/admin-api';

import {
  buildAudioSnapshot,
  buildLevels,
  stageAsrInput,
  stageIngress,
} from './audio-fixtures';

/**
 * PLAN-AUDIOVIZ §9 cross-check gate, render-path leg.
 *
 * The other two legs pin the publisher's meter and the standalone page's DSP to
 * the same expectation table. This one carries a number from that table the last
 * step — through the webapp's stage selection, classification and formatting to
 * the text on screen — so the chain the plan cares about ("from `AudioMeter` to
 * pixels") is covered end to end without a live stack.
 *
 * What it asserts is deliberately narrow: that the dBFS a publisher reports
 * arrives on screen unchanged, that it is taken from the stage the contract says
 * (§12.6's headline stage), and that the status it lands in is the one
 * `AUDIO_THRESHOLDS` defines. A reading that is right in Redis and wrong on the
 * card is the failure mode the two DSP legs cannot see — and since §12 the
 * snapshot carries several readings, so "wrong" now includes "the right number
 * from the wrong measurement point".
 *
 * See `tools/audio-meter-crosscheck/README.md`.
 */

/*
 * Values restated from `tools/audio-meter-crosscheck/fixtures.json`.
 *
 * Restated rather than read: this project deliberately has no node types (see
 * its tsconfig `types: ["vite/client"]`) so that node APIs cannot reach the
 * browser bundle, and a test importing `node:fs` would break `tsc -b`. The copy
 * is guarded instead — `apps/admin-server/tests/unit/shared/mirrored-constants.test.ts`
 * fails if these drift from the manifest.
 */
const TOLERANCE_DB = 0.5;

/** Arithmetic RMS of the manifest's 10 s speech excerpt. */
const SPEECH_EXCERPT_RMS_DBFS = -26.1224;

/** The manifest's calibration tones, by RMS dBFS. */
const TONE_RMS_DBFS = {
  fullScaleSine: -3.0103,
  alignment: -18.0,
  quietRoom: -50.0,
} as const;

/**
 * A published snapshot carrying `levels` at ingress — the measurement point
 * every provider reports and the one §12.6 makes the headline stage, i.e. the
 * reading an operator is shown.
 */
function buildAudio(
  levels: Partial<AudioLevelStats> = {},
): SessionAudioSnapshot {
  return buildAudioSnapshot({
    stages: [stageIngress({ levels: buildLevels(levels) })],
  });
}

describe('render fidelity: the dBFS on screen is the dBFS published', () => {
  const cases = [
    { name: 'speech WAV excerpt', dbfs: SPEECH_EXCERPT_RMS_DBFS },
    { name: 'full-scale 1 kHz sine', dbfs: TONE_RMS_DBFS.fullScaleSine },
    { name: '-18 dBFS alignment tone', dbfs: TONE_RMS_DBFS.alignment },
    { name: 'quiet room tone', dbfs: TONE_RMS_DBFS.quietRoom },
  ];

  for (const { name, dbfs } of cases) {
    it(`renders "${name}" (${String(dbfs)} dBFS) as visible text within the shared tolerance`, () => {
      // Arrange / Act
      render(
        <AudioMeterBar
          rmsDbfs={dbfs}
          status={classifyAudioSnapshot(buildAudio({ rmsDbfs: dbfs }))}
          label="Audio level"
        />,
      );

      // Assert — parse the number back off the screen rather than matching a
      // formatted string, so this checks the *value* survived rendering, not
      // that two format calls agree with each other.
      const text = screen.getByText(/dBFS$/).textContent;
      const shown = Number.parseFloat(text.replace(/[^\d.-]/g, ''));

      expect(Number.isNaN(shown)).toBe(false);
      expect(Math.abs(shown - dbfs)).toBeLessThan(TOLERANCE_DB);
    });
  }

  it('exposes the same figure to assistive tech as it shows sighted users', () => {
    // A meter whose visible text and aria-valuetext disagree is worse than one
    // that only has the text (SC 1.4.1 is satisfied by the text; a wrong
    // valuetext actively misinforms).
    const dbfs = SPEECH_EXCERPT_RMS_DBFS;

    render(
      <AudioMeterBar
        rmsDbfs={dbfs}
        status={classifyAudioSnapshot(buildAudio({ rmsDbfs: dbfs }))}
        label="Audio level"
      />,
    );

    const valuetext =
      screen.getByRole('progressbar').getAttribute('aria-valuetext') ?? '';
    const announced = Number.parseFloat(valuetext);

    expect(Math.abs(announced - dbfs)).toBeLessThan(TOLERANCE_DB);
  });
});

describe('render fidelity: published levels land in the intended status', () => {
  it('classifies the speech excerpt as good', () => {
    // -26 dBFS RMS real speech is a healthy room: between the low and hot
    // bounds, so an operator sees green for audio that is genuinely fine.
    const audio = buildAudio({ rmsDbfs: SPEECH_EXCERPT_RMS_DBFS });

    expect(classifyAudioSnapshot(audio)).toBe('good');
  });

  it('classifies the -50 dBFS room tone on the low boundary as good, not warn', () => {
    // The boundary is exclusive (`rmsDbfs < rmsDbfsLow`), so the threshold value
    // itself is still good. Pinned because an off-by-one here flips every quiet
    // room in the fleet to amber at once.
    const audio = buildAudio({ rmsDbfs: AUDIO_THRESHOLDS.rmsDbfsLow });

    expect(classifyAudioSnapshot(audio)).toBe('good');
    expect(
      classifyAudioSnapshot(
        buildAudio({ rmsDbfs: AUDIO_THRESHOLDS.rmsDbfsLow - 0.1 }),
      ),
    ).toBe('warn');
  });

  it('classifies the full-scale tone as warn on level alone', () => {
    // -3.01 dBFS RMS is above `rmsDbfsHigh` (-6), so it is hot regardless of
    // what the two implementations disagree about for clipping.
    const audio = buildAudio({ rmsDbfs: TONE_RMS_DBFS.fullScaleSine });

    expect(classifyAudioSnapshot(audio)).toBe('warn');
  });

  it('escalates to crit once the publisher reports clipping past the threshold', () => {
    const audio = buildAudio({
      rmsDbfs: TONE_RMS_DBFS.fullScaleSine,
      clippingPct: AUDIO_THRESHOLDS.clippingPctCrit + 0.001,
    });

    expect(classifyAudioSnapshot(audio)).toBe('crit');
  });

  it('classifies the -18 dBFS alignment tone as good', () => {
    // The standard line-up level. If this ever reads anything but good, the
    // dashboard is disagreeing with the tone every other surface is calibrated
    // against.
    const audio = buildAudio({ rmsDbfs: TONE_RMS_DBFS.alignment });

    expect(classifyAudioSnapshot(audio)).toBe('good');
  });

  it('renders the publisher clipping fraction from the known divergence as a percentage', () => {
    // The publisher charges a mathematically full-scale sine 12.5% clipped
    // (see tools/audio-meter-crosscheck/fixtures.json → knownDivergences). If
    // that reaches an operator it must at least read as "12.50%", not "0.13%".
    expect(formatClippingPct(0.125)).toBe('12.50%');
  });
});

describe('render fidelity: the figure comes from the stage the contract names', () => {
  /*
   * Since §12 a snapshot carries several readings, so carrying a number
   * faithfully is no longer sufficient — the render path also has to pick the
   * right one. A dashboard showing the ASR's post-decode level while an operator
   * compares it against a mic-level meter reads as a broken meter, which is the
   * same class of confusion the peak-convention labelling exists to prevent.
   *
   * Each case puts a manifest number at `ingress` and a *different*, deliberately
   * unmistakable number at `asr_input`, so only the correct choice passes.
   */
  const WRONG_STAGE_RMS_DBFS = -41.2;

  it('takes the level from the lowest-depth metered stage, not the deepest', () => {
    // Arrange
    const audio = buildAudioSnapshot({
      stages: [
        stageIngress({
          levels: buildLevels({ rmsDbfs: SPEECH_EXCERPT_RMS_DBFS }),
        }),
        stageAsrInput({
          levels: buildLevels({ rmsDbfs: WRONG_STAGE_RMS_DBFS }),
        }),
      ],
    });

    // Act
    const headline = headlineStage(audio);

    // Assert
    expect(headline?.stage).toBe('ingress');
    expect(
      Math.abs((headline?.levels.rmsDbfs ?? 0) - SPEECH_EXCERPT_RMS_DBFS),
    ).toBeLessThan(TOLERANCE_DB);
  });

  it('shows the ingress figure on screen when a deeper stage reports a different one', () => {
    // Arrange
    const audio = buildAudioSnapshot({
      stages: [
        stageIngress({
          levels: buildLevels({ rmsDbfs: SPEECH_EXCERPT_RMS_DBFS }),
        }),
        stageAsrInput({
          levels: buildLevels({ rmsDbfs: WRONG_STAGE_RMS_DBFS }),
        }),
      ],
    });
    const headline = headlineStage(audio);

    // Act
    render(
      <AudioMeterBar
        rmsDbfs={headline?.levels.rmsDbfs ?? null}
        status={classifyAudioSnapshot(audio)}
        label="Audio level"
      />,
    );

    // Assert — the number parsed back off the screen is the manifest's, within
    // the shared tolerance, and the decoy is nowhere on it.
    const text = screen.getByText(/dBFS$/).textContent;
    const shown = Number.parseFloat(text.replace(/[^\d.-]/g, ''));

    expect(Math.abs(shown - SPEECH_EXCERPT_RMS_DBFS)).toBeLessThan(
      TOLERANCE_DB,
    );
    expect(Math.abs(shown - WRONG_STAGE_RMS_DBFS)).toBeGreaterThan(
      TOLERANCE_DB,
    );
  });

  it('claims no reading at all when no stage carries levels', () => {
    // A provider that counts throughput only has no dBFS to carry, and inventing
    // one — or letting a bar at rest imply silence — would be worse than the
    // absence. `unknown` is the status; there is no figure to check.
    const audio = buildAudioSnapshot({
      stages: [stageAsrInput({ levels: null })],
    });

    expect(headlineStage(audio)).toBeUndefined();
    expect(classifyAudioSnapshot(audio)).toBe('unknown');
  });
});
