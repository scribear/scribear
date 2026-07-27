import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { afterEach, describe, expect, vi } from 'vitest';

import { decodeWav, rmsDbfs } from '@scribear/test-audio-source';

import {
  DEFAULT_LONGFORM_URL,
  type LongformOptions,
  buildLongformWav,
} from '#src/server/shared/clips/longform.js';

/**
 * The `longform` clip (PLAN-TestAudioDevices §2.1).
 *
 * The gate is on the *audio*: five minutes of it, at the right rate, that is
 * actually speech rather than a buffer of the right length.
 */

/** Walks up to the repo root, which differs by how vitest was invoked. */
function repoFile(relative: string): string {
  let dir = process.cwd();
  for (;;) {
    const candidate = resolve(dir, relative);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`Could not locate ${relative}`);
    dir = parent;
  }
}

const HARVARD = repoFile('test_audio_files/speech/harvard_16k_mono.wav');
const APOLLO = repoFile(
  'test_audio_files/speech/apollo11_dialogue_16k_mono.wav',
);

/** No URL: the fixtures path, which is what a build with no egress takes. */
function options(overrides: Partial<LongformOptions> = {}): LongformOptions {
  return {
    sourceUrl: '',
    fallbackPaths: [HARVARD, APOLLO],
    targetSec: 300,
    sampleRate: 16_000,
    channels: 1,
    timeoutMs: 1_000,
    ...overrides,
  };
}

describe('buildLongformWav', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('the fixtures fallback', (it) => {
    it('produces exactly the requested duration at the session format', async () => {
      // Act
      const result = await buildLongformWav(options());

      // Assert — the transcription service rejects audio whose header
      // disagrees with the session rather than resampling it, so this is not a
      // cosmetic property.
      const wav = decodeWav(result.wav);
      expect(wav.sampleRate).toBe(16_000);
      expect(wav.channels).toBe(1);
      expect(wav.durationMs).toBeCloseTo(300_000, -1);
      expect(result.source).toBe('fixtures');
    });

    it('is five minutes of speech, not five minutes of buffer', async () => {
      // Arrange — the failure this catches is a builder that pads with silence
      // to reach the target, which would look identical by duration and would
      // give Whisper nothing to transcribe.
      const result = await buildLongformWav(options());
      const wav = decodeWav(result.wav);

      // Act — measure each 30-second window.
      const windowBytes = 30 * 16_000 * 2;
      const levels: number[] = [];
      for (let at = 0; at + windowBytes <= wav.pcm.length; at += windowBytes) {
        levels.push(rmsDbfs(wav.pcm.subarray(at, at + windowBytes)));
      }

      // Assert — every window carries audio well above the meter's silence
      // floor (0.01 linear RMS, -40 dBFS).
      expect(levels.length).toBeGreaterThanOrEqual(9);
      for (const level of levels) expect(level).toBeGreaterThan(-40);
    });

    it('is deterministic, so two deployments build byte-identical audio', async () => {
      // Arrange — captions cannot be compared between deployments that are
      // listening to different audio, and the fallback is the common case.
      const first = await buildLongformWav(options());
      const second = await buildLongformWav(options());

      // Assert
      expect(first.wav.equals(second.wav)).toBe(true);
    });

    it('interleaves the two fixtures rather than repeating one', async () => {
      // Arrange — a clip that were just `harvard` on a loop would reintroduce
      // the short-cycle problem this exists to solve.
      const both = await buildLongformWav(options());
      const onlyHarvard = await buildLongformWav(
        options({ fallbackPaths: [HARVARD] }),
      );

      // Assert
      expect(both.wav.equals(onlyHarvard.wav)).toBe(false);
    });

    it('says in its note that the download was not used', async () => {
      // Act
      const result = await buildLongformWav(options());

      // Assert — an operator comparing two deployments has to be able to tell
      // which audio each is playing.
      expect(result.note).toMatch(/Thue-Morse/);
      expect(result.note).toMatch(/TEST_AUDIO_LONGFORM_URL is empty/);
    });

    it('refuses a fixture at the wrong rate rather than streaming it', async () => {
      // Act + Assert
      await expect(
        buildLongformWav(options({ sampleRate: 44_100 })),
      ).rejects.toThrow(/not 44100 Hz/);
    });
  });

  describe('the download', (it) => {
    /** A WAV of `seconds` of a 220 Hz tone, standing in for the real item. */
    function toneWav(seconds: number, sampleRate = 16_000): Buffer {
      const count = seconds * sampleRate;
      const pcm = Buffer.alloc(count * 2);
      for (let i = 0; i < count; i++) {
        pcm.writeInt16LE(
          Math.round(16_000 * Math.sin((2 * Math.PI * 220 * i) / sampleRate)),
          i * 2,
        );
      }
      const header = Buffer.alloc(44);
      header.write('RIFF', 0, 'ascii');
      header.writeUInt32LE(36 + pcm.length, 4);
      header.write('WAVE', 8, 'ascii');
      header.write('fmt ', 12, 'ascii');
      header.writeUInt32LE(16, 16);
      header.writeUInt16LE(1, 20);
      header.writeUInt16LE(1, 22);
      header.writeUInt32LE(sampleRate, 24);
      header.writeUInt32LE(sampleRate * 2, 28);
      header.writeUInt16LE(2, 32);
      header.writeUInt16LE(16, 34);
      header.write('data', 36, 'ascii');
      header.writeUInt32LE(pcm.length, 40);
      return Buffer.concat([header, pcm]);
    }

    function stubFetch(body: Buffer | Error, status = 200) {
      vi.stubGlobal(
        'fetch',
        vi.fn(() => {
          if (body instanceof Error) return Promise.reject(body);
          return Promise.resolve({
            ok: status >= 200 && status < 300,
            status,
            arrayBuffer: () =>
              Promise.resolve(
                body.buffer.slice(
                  body.byteOffset,
                  body.byteOffset + body.byteLength,
                ),
              ),
          } as unknown as Response);
        }),
      );
    }

    it('uses the download when it is the right format and long enough', async () => {
      // Arrange
      stubFetch(toneWav(310));

      // Act
      const result = await buildLongformWav(
        options({ sourceUrl: 'https://example.test/clip.wav' }),
      );

      // Assert
      expect(result.source).toBe('download');
      expect(decodeWav(result.wav).durationMs).toBeCloseTo(300_000, -1);
    });

    it('falls back rather than failing the build when the fetch fails', async () => {
      // Arrange — a build host with no egress is a normal case, and an image
      // build must not fail over an unreachable mirror.
      stubFetch(new Error('getaddrinfo ENOTFOUND'));

      // Act
      const result = await buildLongformWav(
        options({ sourceUrl: 'https://example.test/clip.wav' }),
      );

      // Assert — and the reason is carried into the note, so the log says why.
      expect(result.source).toBe('fixtures');
      expect(result.note).toMatch(/ENOTFOUND/);
    });

    it('rejects a source at the wrong rate rather than aliasing it down', async () => {
      // Arrange — no resampler is shipped on purpose: decimating without an
      // anti-alias filter folds everything above 8 kHz into the speech band.
      stubFetch(toneWav(310, 48_000));

      // Act
      const result = await buildLongformWav(
        options({ sourceUrl: 'https://example.test/clip.wav' }),
      );

      // Assert
      expect(result.source).toBe('fixtures');
      expect(result.note).toMatch(/48000 Hz/);
      expect(result.note).toMatch(/no resampler/);
    });

    it('rejects a source shorter than the target rather than looping it', async () => {
      // Arrange
      stubFetch(toneWav(60));

      // Act
      const result = await buildLongformWav(
        options({ sourceUrl: 'https://example.test/clip.wav' }),
      );

      // Assert
      expect(result.source).toBe('fixtures');
      expect(result.note).toMatch(/short of the 300s target/);
    });

    it('falls back on a non-200 rather than parsing an error page as audio', async () => {
      // Arrange
      stubFetch(Buffer.from('<html>404</html>'), 404);

      // Act
      const result = await buildLongformWav(
        options({ sourceUrl: 'https://example.test/clip.wav' }),
      );

      // Assert
      expect(result.source).toBe('fixtures');
      expect(result.note).toMatch(/HTTP 404/);
    });
  });

  describe('the default source', (it) => {
    it('is a plain https URL, so the build needs no credentials or client', () => {
      // Assert — anything needing a login or an SDK would be unbuildable in a
      // container, which is where this runs.
      expect(DEFAULT_LONGFORM_URL).toMatch(/^https:\/\//);
      expect(DEFAULT_LONGFORM_URL).toMatch(/\.wav$/);
    });
  });
});
