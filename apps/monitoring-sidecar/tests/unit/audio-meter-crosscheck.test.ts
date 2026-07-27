import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect } from 'vitest';

import { decodeWav } from '@scribear/test-audio-source';

/**
 * PLAN-AUDIOVIZ §9 cross-check gate, standalone-page leg.
 *
 * `audio-meter-dsp.test.ts` already gates this page's maths against tones it
 * defines itself. This suite is different: it reads the *shared* expectation
 * table in `tools/audio-meter-crosscheck/fixtures.json`, the same table the
 * Python publisher's meter is held to, so that the two surfaces an operator
 * compares side by side are pinned to one set of numbers rather than to two
 * independently-written ones.
 *
 * See `tools/audio-meter-crosscheck/README.md` for what this does and does not
 * cover — notably, it stops at the DSP and does not exercise the live transport.
 */

const REPO_ROOT = new URL('../../../../', import.meta.url);

const HTML_PATH = fileURLToPath(
  new URL('libs/audio-meter-page/audio-meter.html', REPO_ROOT),
);
const FIXTURES_PATH = fileURLToPath(
  new URL('tools/audio-meter-crosscheck/fixtures.json', REPO_ROOT),
);

interface Expected {
  rmsDbfs: number;
  peakDbfs: number;
  clippingPct: number;
}

interface ToneFixture {
  name: string;
  rmsDbfs: number;
  frequencyHz: number;
  sampleRate: number;
  seconds: number;
  expected: Expected;
}

interface WavFixture {
  path: string;
  sampleRate: number;
  sampleCount: number;
  expected: Expected;
}

interface LimitedToneFixture extends ToneFixture {
  /** Gain applied before hard-limiting. */
  preLimitGain: number;
  /** Ceiling the signal is limited to; defaults to full scale. */
  limitCeiling?: number;
}

interface Fixtures {
  toleranceDb: number;
  wav: WavFixture;
  tones: ToneFixture[];
  limitedTones: LimitedToneFixture[];
}

interface Readings {
  rmsDb: number;
  heldPeakDb: number;
  peakDb: number;
  maxTruePeakDb: number;
  clippingPercent: number;
}

interface MeterCore {
  process(block: Float32Array): void;
  read(): Readings;
}

interface Dsp {
  AudioMeterCore: new (
    sampleRate: number,
    options?: Record<string, number>,
  ) => MeterCore;
}

/** Same extraction as `audio-meter-dsp.test.ts`: evaluate the page's own DSP
 *  block so the shipped text and the tested maths cannot drift apart. */
function loadDsp(): Dsp {
  const html = readFileSync(HTML_PATH, 'utf8');
  const match = /<script id="meter-dsp">([\s\S]*?)<\/script>/.exec(html);
  if (!match?.[1])
    throw new Error('meter-dsp script block not found in the page');
  const sandbox: { ScribeArAudioMeter?: Dsp } = {};
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const install = new Function('globalThis', match[1]) as (
    scope: typeof sandbox,
  ) => void;
  install(sandbox);
  if (!sandbox.ScribeArAudioMeter)
    throw new Error('DSP block exported nothing');
  return sandbox.ScribeArAudioMeter;
}

/**
 * Decodes the fixture WAV with the sidecar's own reader — the same
 * `decodeWav` the synthetic canary uses to put fixture audio on the wire, so
 * this leg reads the file exactly as production does rather than through a
 * second parser written for the test.
 */
function readFixtureWav(path: string): {
  sampleRate: number;
  samples: Float32Array;
} {
  const decoded = decodeWav(readFileSync(path));
  if (decoded.channels !== 1) {
    throw new Error(`expected mono, got ${String(decoded.channels)} channels`);
  }
  const samples = new Float32Array(Math.floor(decoded.pcm.length / 2));
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = decoded.pcm.readInt16LE(i * 2) / 32768;
  }
  return { sampleRate: decoded.sampleRate, samples };
}

const BLOCK = 128;

/** Feeds samples through the core in worklet-sized blocks, as the page does. */
function feed(core: MeterCore, samples: Float32Array): void {
  for (let written = 0; written < samples.length; written += BLOCK) {
    core.process(
      samples.subarray(written, Math.min(written + BLOCK, samples.length)),
    );
  }
}

function sineSamples(fixture: ToneFixture): Float32Array {
  // A = 10^(dBFS/20) * sqrt(2), so the sine's RMS (A/sqrt(2)) is the target.
  const amplitude = Math.pow(10, fixture.rmsDbfs / 20) * Math.SQRT2;
  const total = Math.round(fixture.seconds * fixture.sampleRate);
  const out = new Float32Array(total);
  for (let i = 0; i < total; i += 1) {
    out[i] =
      amplitude *
      Math.sin((2 * Math.PI * fixture.frequencyHz * i) / fixture.sampleRate);
  }
  return out;
}

const dsp = loadDsp();
const fixtures = JSON.parse(readFileSync(FIXTURES_PATH, 'utf8')) as Fixtures;
const TOLERANCE_DB = fixtures.toleranceDb;

describe('cross-check: shared tone fixtures', (it) => {
  for (const tone of fixtures.tones) {
    it(`reads "${tone.name}" within the shared tolerance`, () => {
      // Arrange
      const core = new dsp.AudioMeterCore(tone.sampleRate);

      // Act
      feed(core, sineSamples(tone));
      const readings = core.read();

      // Assert — the same numbers audio_meter.py is held to for this fixture.
      expect(Math.abs(readings.rmsDb - tone.expected.rmsDbfs)).toBeLessThan(
        TOLERANCE_DB,
      );
      expect(
        Math.abs(readings.heldPeakDb - tone.expected.peakDbfs),
      ).toBeLessThan(TOLERANCE_DB);
      expect(readings.clippingPercent).toBe(tone.expected.clippingPct * 100);
    });
  }
});

/** Feeds one full metering window of the fixture WAV and reads the meter. */
function readWavFixture(): Readings {
  const { path, sampleRate, sampleCount } = fixtures.wav;
  const wav = readFixtureWav(fileURLToPath(new URL(path, REPO_ROOT)));
  expect(wav.sampleRate).toBe(sampleRate);
  expect(wav.samples.length).toBeGreaterThanOrEqual(sampleCount);

  const core = new dsp.AudioMeterCore(sampleRate);
  feed(core, wav.samples.subarray(0, sampleCount));
  return core.read();
}

describe('cross-check: known speech WAV', (it) => {
  it('reads the excerpt RMS within the shared tolerance', () => {
    // Arrange / Act — exactly one full metering window of real speech, so the
    // reading averages precisely the samples the expectation was computed over.
    const readings = readWavFixture();

    // Assert — an arithmetic expectation, not a value copied from either meter.
    // RMS is the number the dashboard's meter bar renders, so this is the
    // assertion that makes the two surfaces agree on what the operator sees.
    expect(
      Math.abs(readings.rmsDb - fixtures.wav.expected.rmsDbfs),
    ).toBeLessThan(TOLERANCE_DB);
  });

  it('reads the excerpt peak within the shared tolerance', () => {
    // Act
    const readings = readWavFixture();

    // Assert — `maxTruePeakDb` is the field comparable to the publisher's
    // `peak_dbfs` (`max|x|` over the window): both are a maximum over
    // everything seen. It is an oversampled reconstruction rather than a sample
    // maximum, so it does not bracket the sample peak from either side — the
    // polyphase filter's passband loss puts it ~0.001 dB *below* it on this
    // excerpt, well inside the gate.
    expect(
      Math.abs(readings.maxTruePeakDb - fixtures.wav.expected.peakDbfs),
    ).toBeLessThan(TOLERANCE_DB);
  });

  it('exposes no clipping for an excerpt that has none', () => {
    expect(readWavFixture().clippingPercent).toBe(
      fixtures.wav.expected.clippingPct * 100,
    );
  });

  it('does not expose a window-max sample peak — `peakDb` is a recent-peak meter', () => {
    // A divergence worth pinning down rather than papering over: the publisher's
    // `peak_dbfs` is the max over its whole window, but this page has no such
    // field. `peakDb` / `heldPeakDb` are a short peak window with hold-and-decay
    // (a broadcast-style peak meter), so on a long excerpt they report the
    // *recent* peak and sit well below the excerpt maximum. Anyone comparing the
    // two surfaces' "Peak" readings is comparing different measurements; this
    // asserts the difference is real so nobody "fixes" the cross-check by
    // pointing it at the wrong field.
    const readings = readWavFixture();

    expect(readings.peakDb).toBeLessThan(
      fixtures.wav.expected.peakDbfs - TOLERANCE_DB,
    );
    expect(readings.heldPeakDb).toBeLessThan(
      fixtures.wav.expected.peakDbfs - TOLERANCE_DB,
    );
  });
});

/** Hard-limits a tone to +/-`limitCeiling` after applying its pre-limit gain.
 *  A ceiling below CLIP_THRESHOLD yields a flat plateau that must NOT be charged. */
function limitedSineSamples(fixture: LimitedToneFixture): Float32Array {
  const ceiling = fixture.limitCeiling ?? 1;
  // `map` rather than an indexed write loop: TypeScript 6 types indexed reads on
  // a typed array as `number | undefined`, and a `?? 0` fallback here would
  // silently substitute silence for a bug rather than failing.
  return sineSamples(fixture).map((sample) =>
    Math.max(-ceiling, Math.min(ceiling, fixture.preLimitGain * sample)),
  );
}

describe('cross-check: hard-limited audio', (it) => {
  /*
   * The counterpart to the clean full-scale sine above. Requiring a run at the
   * rail is only the right rule if it still catches real clipping, so these pin
   * the positive cases too — and one fixture whose plateau sits *below* the
   * threshold, which pins the threshold from below. Between them, both halves of
   * the shared rule (threshold and minimum run) fail a test if either drifts.
   */
  for (const tone of fixtures.limitedTones) {
    it(`charges "${tone.name}" the shared fraction`, () => {
      // Arrange
      const core = new dsp.AudioMeterCore(tone.sampleRate);

      // Act
      feed(core, limitedSineSamples(tone));
      const readings = core.read();

      // Assert — an exact comparison: clippingPct is a counted fraction of
      // samples, not a measurement, so the two implementations must agree to
      // the digit rather than within a dB tolerance.
      expect(readings.clippingPercent).toBeCloseTo(
        tone.expected.clippingPct * 100,
        4,
      );
      expect(Math.abs(readings.rmsDb - tone.expected.rmsDbfs)).toBeLessThan(
        TOLERANCE_DB,
      );
    });
  }

  it('puts genuinely clipped audio past the dashboard crit threshold', () => {
    // The rule must still be actionable: a red "clipping" chip fires at 1%.
    const clipping = fixtures.limitedTones.filter(
      (t) => t.expected.clippingPct > 0,
    );

    expect(clipping.length).toBeGreaterThan(0);
    for (const tone of clipping) {
      expect(tone.expected.clippingPct).toBeGreaterThan(0.01);
    }
  });
});
