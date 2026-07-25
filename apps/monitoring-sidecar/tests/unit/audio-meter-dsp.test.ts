import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect } from 'vitest';

/**
 * Gate A4: the standalone audio meter must read known tones within ±0.5 dB.
 *
 * The meter ships as one self-contained HTML page (no build step, no imports —
 * an audio engineer opens it from a file on the source machine), so there is no
 * module to import. The DSP is deliberately isolated in a single DOM-free
 * `<script id="meter-dsp">` element; this suite extracts that element's source
 * and evaluates it against a sandbox global. That keeps the page shippable as
 * one file while still putting its maths under CI, with no copy to drift.
 */

const HTML_PATH = fileURLToPath(
  new URL(
    '../../../../libs/audio-meter-page/audio-meter.html',
    import.meta.url,
  ),
);

const TOLERANCE_DB = 0.5;

interface Readings {
  sampleRate: number;
  processedSec: number;
  rmsDb: number;
  fastRmsDb: number;
  noiseFloorDb: number;
  peakDb: number;
  heldPeakDb: number;
  truePeakDb: number;
  maxTruePeakDb: number;
  clippedSamples: number;
  clippingPercent: number;
  silenceSec: number;
  silent: boolean;
  momentaryLufs: number;
  shortTermLufs: number;
  integratedLufs: number;
  targetLufs: number;
  shortTermLu: number;
  zone: 'good' | 'warning' | 'critical';
}

interface MeterCore {
  options: Record<string, number>;
  process(block: Float32Array): void;
  read(): Readings;
}

interface Dsp {
  DB_FLOOR: number;
  AudioMeterCore: new (
    sampleRate: number,
    options?: Record<string, number>,
  ) => MeterCore;
  designKWeighting(sampleRate: number): {
    shelf: { b0: number; b1: number; b2: number; a1: number; a2: number };
    highpass: { b0: number; b1: number; b2: number; a1: number; a2: number };
  };
  classifyPeak(peakDb: number, options: Record<string, number>): string;
}

function loadDsp(): Dsp {
  const html = readFileSync(HTML_PATH, 'utf8');
  const match = /<script id="meter-dsp">([\s\S]*?)<\/script>/.exec(html);
  if (!match?.[1])
    throw new Error('meter-dsp script block not found in the page');

  // The block installs itself on whatever `globalThis` resolves to, so passing
  // a bare object as that parameter keeps the evaluation out of Node's global.
  const sandbox: { ScribeArAudioMeter?: Dsp } = {};
  // Evaluating the page's own DSP source is the point of this suite: it is what
  // keeps the shipped page and the tested maths the same text.
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const install = new Function('globalThis', match[1]) as (
    scope: typeof sandbox,
  ) => void;
  install(sandbox);
  if (!sandbox.ScribeArAudioMeter)
    throw new Error('DSP block exported nothing');
  return sandbox.ScribeArAudioMeter;
}

const dsp = loadDsp();

const SAMPLE_RATE = 48_000;
const BLOCK = 128;

/** Feeds a generated signal through the core in worklet-sized blocks. */
function feed(
  core: MeterCore,
  seconds: number,
  sample: (index: number) => number,
  startIndex = 0,
): number {
  const total = Math.round(seconds * SAMPLE_RATE);
  const block = new Float32Array(BLOCK);
  let index = startIndex;
  for (let written = 0; written < total; written += BLOCK) {
    const length = Math.min(BLOCK, total - written);
    for (let i = 0; i < length; i += 1) block[i] = sample(index + i);
    core.process(length === BLOCK ? block : block.subarray(0, length));
    index += length;
  }
  return index;
}

function sine(amplitude: number, frequency: number, phase = 0) {
  return (index: number) =>
    amplitude *
    Math.sin((2 * Math.PI * frequency * index) / SAMPLE_RATE + phase);
}

/** dBFS amplitude of a sine whose RMS should read `db` under the plain reference. */
function amplitudeForRmsDb(db: number): number {
  return Math.pow(10, db / 20) * Math.SQRT2;
}

function newCore(options?: Record<string, number>): MeterCore {
  return new dsp.AudioMeterCore(SAMPLE_RATE, options);
}

describe('K-weighting design', (it) => {
  it('reproduces the BS.1770 48 kHz coefficient table', () => {
    // Act
    const { shelf, highpass } = dsp.designKWeighting(48_000);

    // Assert — the values tabulated in ITU-R BS.1770-4 Tables 1 and 2.
    expect(shelf.b0).toBeCloseTo(1.53512485958697, 8);
    expect(shelf.b1).toBeCloseTo(-2.69169618940638, 8);
    expect(shelf.b2).toBeCloseTo(1.19839281085285, 8);
    expect(shelf.a1).toBeCloseTo(-1.69065929318241, 8);
    expect(shelf.a2).toBeCloseTo(0.73248077421585, 8);

    expect(highpass.a1).toBeCloseTo(-1.99004745483398, 6);
    expect(highpass.a2).toBeCloseTo(0.99007225036621, 6);
  });

  it('stays stable at other device rates', () => {
    // Arrange — 44.1 and 16 kHz are both rates ScribeAR sources actually run at.
    for (const rate of [16_000, 44_100, 96_000]) {
      // Act
      const { shelf, highpass } = dsp.designKWeighting(rate);

      // Assert — poles inside the unit circle: |a2| < 1 and |a1| < 1 + a2.
      for (const stage of [shelf, highpass]) {
        expect(Math.abs(stage.a2)).toBeLessThan(1);
        expect(Math.abs(stage.a1)).toBeLessThan(1 + stage.a2);
      }
    }
  });
});

describe('level measurement', (it) => {
  it('reads a full-scale sine at -3.01 dBFS under the plain reference', () => {
    // Arrange
    const core = newCore();

    // Act
    feed(core, 11, sine(1, 1000));
    const readings = core.read();

    // Assert
    expect(readings.rmsDb).toBeCloseTo(-3.01, 1);
    expect(Math.abs(readings.rmsDb - -3.01)).toBeLessThan(TOLERANCE_DB);
  });

  it('reads the same sine at 0 dBFS under AES17', () => {
    // Arrange
    const core = newCore({ rmsReferenceOffsetDb: 3.0103 });

    // Act
    feed(core, 11, sine(1, 1000));
    const readings = core.read();

    // Assert
    expect(Math.abs(readings.rmsDb)).toBeLessThan(TOLERANCE_DB);
    // The peak reference is full scale either way — the offset is RMS-domain only.
    expect(Math.abs(readings.heldPeakDb)).toBeLessThan(TOLERANCE_DB);
  });

  it('reads a -18 dBFS alignment tone at -18', () => {
    // Arrange
    const core = newCore();

    // Act
    feed(core, 11, sine(amplitudeForRmsDb(-18), 1000));
    const readings = core.read();

    // Assert — the zone boundaries are peak thresholds (§4.1), and this tone's
    // peak is 3.01 dB above its RMS, so a -18 dBFS *RMS* alignment tone sits
    // just inside the amber band. That is the convention, not a rounding error:
    // the boundary guards headroom, which peak defines.
    expect(Math.abs(readings.rmsDb - -18)).toBeLessThan(TOLERANCE_DB);
    expect(Math.abs(readings.heldPeakDb - -15.01)).toBeLessThan(TOLERANCE_DB);
  });

  it('classifies a hot signal as warning and a near-clipping one as critical', () => {
    // Arrange
    const warm = newCore();
    const hot = newCore();

    // Act
    feed(warm, 2, sine(amplitudeForRmsDb(-12), 1000));
    feed(hot, 2, sine(amplitudeForRmsDb(-3), 1000));

    // Assert — the boundaries are peak-based, so a -12 dBFS RMS sine (peak
    // -9 dBFS) is amber and a -3 dBFS RMS sine (peak 0 dBFS) is red.
    expect(warm.read().zone).toBe('warning');
    expect(hot.read().zone).toBe('critical');
  });

  it('holds the peak, then decays it', () => {
    // Arrange
    const core = newCore();

    // Act — one loud burst, then a long quiet stretch.
    const index = feed(core, 0.2, sine(1, 1000));
    const duringBurst = core.read();
    feed(core, 1.5, sine(amplitudeForRmsDb(-40), 1000), index);
    const withinHold = core.read();
    feed(core, 3, sine(amplitudeForRmsDb(-40), 1000), index);
    const afterHold = core.read();

    // Assert
    expect(Math.abs(duringBurst.heldPeakDb)).toBeLessThan(TOLERANCE_DB);
    expect(Math.abs(withinHold.heldPeakDb)).toBeLessThan(TOLERANCE_DB);
    expect(afterHold.heldPeakDb).toBeLessThan(withinHold.heldPeakDb - 10);
  });
});

describe('true peak', (it) => {
  it('recovers an inter-sample peak the sample peak misses', () => {
    // Arrange — a full-scale sine at fs/4 sampled 45° off the crests never
    // lands on one: every sample sits at ±0.7071 (-3.01 dBFS).
    const core = newCore();

    // Act
    feed(core, 1, sine(1, SAMPLE_RATE / 4, Math.PI / 4));
    const readings = core.read();

    // Assert
    expect(Math.abs(readings.peakDb - -3.01)).toBeLessThan(0.1);
    expect(Math.abs(readings.truePeakDb)).toBeLessThan(TOLERANCE_DB);
    expect(readings.truePeakDb).toBeGreaterThan(readings.peakDb);
  });

  it('does not overstate the peak of a signal sampled on its crests', () => {
    // Arrange
    const core = newCore();

    // Act — fs/4 with a 90° phase lands exactly on ±1.
    feed(core, 1, sine(1, SAMPLE_RATE / 4, Math.PI / 2));
    const readings = core.read();

    // Assert
    expect(Math.abs(readings.maxTruePeakDb)).toBeLessThan(TOLERANCE_DB);
  });
});

describe('clipping and silence', (it) => {
  it('reports the clipped fraction of a hard-limited sine', () => {
    // Arrange — an overdriven sine, clipped flat at ±1.
    const core = newCore();
    const overdriven = sine(1.5, 1000);

    // Act
    feed(core, 5, (i) => Math.max(-1, Math.min(1, overdriven(i))));
    const readings = core.read();

    // Assert — asin(1/1.5)/(π/2) of each half-cycle survives, so ~27 % of
    // samples sit at the rail.
    const expected = 100 * (1 - (2 * Math.asin(1 / 1.5)) / Math.PI);
    expect(readings.clippingPercent).toBeGreaterThan(expected - 2);
    expect(readings.clippingPercent).toBeLessThan(expected + 2);
  });

  it('ignores isolated full-scale samples below the run length', () => {
    // Arrange — a quiet tone with a single-sample spike every 10 ms.
    const core = newCore();
    const quiet = sine(amplitudeForRmsDb(-30), 1000);

    // Act
    feed(core, 5, (i) => (i % 480 === 0 ? 1 : quiet(i)));
    const readings = core.read();

    // Assert — the spikes still move the peak, but nothing is charged as clipping.
    expect(readings.clippingPercent).toBe(0);
    expect(Math.abs(readings.heldPeakDb)).toBeLessThan(TOLERANCE_DB);
  });

  it('flags digital silence once it has persisted', () => {
    // Arrange
    const core = newCore();

    // Act
    feed(core, 0.5, () => 0);
    const early = core.read();
    feed(core, 2, () => 0);
    const late = core.read();

    // Assert — C1: a muted or unplugged mic, the failure this page exists for.
    expect(early.silent).toBe(false);
    expect(late.silent).toBe(true);
    expect(late.rmsDb).toBeLessThanOrEqual(dsp.DB_FLOOR);
  });

  it('does not call a quiet but present signal silent', () => {
    // Arrange — a room at -50 dBFS is quiet; it is not a dead input.
    const core = newCore();

    // Act
    feed(core, 3, sine(amplitudeForRmsDb(-50), 200));

    // Assert
    expect(core.read().silent).toBe(false);
  });
});

describe('noise floor', (it) => {
  it('estimates the floor between speech-like bursts', () => {
    // Arrange — 400 ms of -20 dBFS tone, then 600 ms of -55 dBFS hiss, repeated.
    const core = newCore();
    const loud = sine(amplitudeForRmsDb(-20), 300);
    const floorAmplitude = amplitudeForRmsDb(-55);

    // Act
    feed(core, 10, (i) => {
      const phase = (i / SAMPLE_RATE) % 1;
      return phase < 0.4
        ? loud(i)
        : floorAmplitude * Math.sin((2 * Math.PI * 4000 * i) / SAMPLE_RATE);
    });
    const readings = core.read();

    // Assert
    expect(Math.abs(readings.noiseFloorDb - -55)).toBeLessThan(3);
    expect(readings.rmsDb).toBeGreaterThan(readings.noiseFloorDb + 20);
  });
});

describe('loudness', (it) => {
  it('tracks level changes decibel for decibel', () => {
    // Arrange
    const quiet = newCore();
    const loud = newCore();

    // Act
    feed(quiet, 4, sine(amplitudeForRmsDb(-30), 1000));
    feed(loud, 4, sine(amplitudeForRmsDb(-20), 1000));

    // Assert
    const delta = loud.read().shortTermLufs - quiet.read().shortTermLufs;
    expect(Math.abs(delta - 10)).toBeLessThan(0.1);
  });

  it('reads a 1 kHz tone close to its unweighted level', () => {
    // Arrange — K-weighting is near unity at 1 kHz, so momentary loudness and
    // the RMS level should agree to within a couple of dB. This is the check
    // that catches a filter designed at the wrong sample rate.
    const core = newCore();

    // Act
    feed(core, 4, sine(amplitudeForRmsDb(-23), 1000));
    const readings = core.read();

    // Assert
    expect(Math.abs(readings.momentaryLufs - -23)).toBeLessThan(2);
    expect(
      Math.abs(readings.shortTermLufs - readings.momentaryLufs),
    ).toBeLessThan(0.5);
  });

  it('reports short-term loudness relative to the configured target', () => {
    // Arrange
    const core = newCore({ loudnessTargetLufs: -16 });

    // Act
    feed(core, 4, sine(amplitudeForRmsDb(-26), 1000));
    const readings = core.read();

    // Assert
    expect(readings.targetLufs).toBe(-16);
    expect(readings.shortTermLu).toBeCloseTo(readings.shortTermLufs - -16, 6);
  });

  it('gates silence out of the integrated measurement', () => {
    // Arrange — 3 s of programme, then 12 s of nothing.
    const core = newCore();

    // Act
    const index = feed(core, 3, sine(amplitudeForRmsDb(-20), 1000));
    const duringProgramme = core.read().shortTermLufs;
    feed(core, 12, () => 0, index);
    const readings = core.read();

    // Assert — without gating the silence would drag the integrated value down
    // by more than 6 dB; with it, the number still describes the programme.
    expect(Math.abs(readings.integratedLufs - duringProgramme)).toBeLessThan(1);
    expect(readings.shortTermLufs).toBeLessThan(readings.integratedLufs - 20);
  });
});

describe('window behaviour', (it) => {
  it('keeps the 10 s RMS window bounded while the fast window follows the signal', () => {
    // Arrange
    const core = newCore();

    // Act — 10 s at -40 dBFS, then 1 s at -10.
    const index = feed(core, 10, sine(amplitudeForRmsDb(-40), 500));
    feed(core, 1, sine(amplitudeForRmsDb(-10), 500), index);
    const readings = core.read();

    // Assert — the fast bar has already moved; the 10 s average has not.
    expect(Math.abs(readings.fastRmsDb - -10)).toBeLessThan(TOLERANCE_DB);
    expect(readings.rmsDb).toBeLessThan(-15);
    expect(readings.rmsDb).toBeGreaterThan(-40);
  });
});
