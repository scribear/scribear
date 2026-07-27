import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect } from 'vitest';

import { decodeWav, encodeWav } from '@scribear/test-audio-source';

import {
  type ClipCatalogConfig,
  ClipCatalogService,
} from '#src/server/shared/clips/clip-catalog.service.js';
import { silentLogger } from '#tests/utils/silent-logger.js';

/**
 * The clip catalog.
 *
 * Two things are worth pinning here: that a fixture at the wrong rate is caught
 * at load rather than one frame at a time on the wire, and that the `longform`
 * clip is built on first use when the image build did not produce it — which is
 * the path a local `npm run dev` always takes.
 */

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

const dirs: string[] = [];

async function scratchDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'test-audio-clips-'));
  dirs.push(dir);
  return dir;
}

function config(overrides: Partial<ClipCatalogConfig> = {}): ClipCatalogConfig {
  return {
    clipPaths: {
      harvard: HARVARD,
      apollo: APOLLO,
      longform: '/nonexistent/longform.wav',
    },
    longform: {
      sourceUrl: '',
      fallbackPaths: [HARVARD, APOLLO],
      // Short, so the fallback build is quick; the duration itself is the
      // longform builder's own test.
      targetSec: 12,
      sampleRate: 16_000,
      channels: 1,
      timeoutMs: 1_000,
    },
    chunkMs: 100,
    expectedSampleRate: 16_000,
    expectedChannels: 1,
    ...overrides,
  };
}

function catalog(overrides: Partial<ClipCatalogConfig> = {}) {
  return new ClipCatalogService(config(overrides), silentLogger());
}

describe('ClipCatalogService', () => {
  afterEach(async () => {
    await Promise.all(
      dirs
        .splice(0, dirs.length)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  describe('loading a committed fixture', (it) => {
    it('slices it into chunks at the configured framing rate', async () => {
      // Act
      const chunks = await catalog().load('harvard');

      // Assert — 100 ms matches the kiosk's AUDIO_CHUNK_MS, so these devices
      // frame audio at the rate real source devices do.
      expect(chunks.length).toBeGreaterThan(300);
      expect(chunks[0]?.durationMs).toBeCloseTo(100, 5);
    });

    it('emits each chunk as a complete WAV file, as a real source does', async () => {
      // Arrange — a real source is the audio worklet, which sends one whole
      // 44-byte-header RIFF file per chunk. `soundfile` opens each one.
      const chunks = await catalog().load('harvard');

      // Act
      const decoded = decodeWav(chunks[0]?.wav ?? Buffer.alloc(0));

      // Assert
      expect(decoded.sampleRate).toBe(16_000);
      expect(decoded.channels).toBe(1);
    });

    it('caches, so pressing start does not re-slice five minutes of audio', async () => {
      // Arrange
      const clips = catalog();

      // Act
      const first = await clips.load('harvard');
      const second = await clips.load('harvard');

      // Assert
      expect(second).toBe(first);
    });

    it('loads a clip once even when both devices ask at the same instant', async () => {
      // Arrange — both devices can be started on the same clip in the same
      // tick, and `longform` may have to be built on that first use.
      const clips = catalog();

      // Act
      const [a, b] = await Promise.all([
        clips.load('apollo'),
        clips.load('apollo'),
      ]);

      // Assert
      expect(a).toBe(b);
    });
  });

  describe('a fixture in the wrong format', (it) => {
    it('is refused at load, not one rejected frame at a time', async () => {
      // Arrange — the transcription service raises on a rate mismatch rather
      // than resampling, so a wrong fixture means every frame is rejected and
      // the operator sees a silent pipeline with no explanation.
      const dir = await scratchDir();
      const path = join(dir, 'wrong-rate.wav');
      await writeFile(path, encodeWav(Buffer.alloc(3_200), 8_000, 1));
      const clips = catalog({
        clipPaths: { harvard: path, apollo: APOLLO, longform: path },
      });

      // Act + Assert
      await expect(clips.load('harvard')).rejects.toThrow(
        /8000 Hz but sessions expect 16000 Hz/,
      );
    });

    it('names the channel count when that is what disagrees', async () => {
      // Arrange
      const dir = await scratchDir();
      const path = join(dir, 'stereo.wav');
      await writeFile(path, encodeWav(Buffer.alloc(3_200), 16_000, 2));
      const clips = catalog({
        clipPaths: { harvard: path, apollo: APOLLO, longform: path },
      });

      // Act + Assert
      await expect(clips.load('harvard')).rejects.toThrow(/2 channel/);
    });
  });

  describe('the longform clip', (it) => {
    it('is built on first use when the image build did not produce it', async () => {
      // Arrange — the path a local `npm run dev` always takes.
      const dir = await scratchDir();
      const path = join(dir, 'nested', 'longform.wav');
      const clips = catalog({
        clipPaths: { harvard: HARVARD, apollo: APOLLO, longform: path },
      });

      // Act
      const chunks = await clips.load('longform');

      // Assert
      const totalMs = chunks.reduce((sum, chunk) => sum + chunk.durationMs, 0);
      expect(totalMs).toBeCloseTo(12_000, -2);
    });

    it('caches what it built to disk, so the next restart just reads it', async () => {
      // Arrange
      const dir = await scratchDir();
      const path = join(dir, 'nested', 'longform.wav');

      // Act
      await catalog({
        clipPaths: { harvard: HARVARD, apollo: APOLLO, longform: path },
      }).load('longform');

      // Assert
      const written = decodeWav(await readFile(path));
      expect(written.sampleRate).toBe(16_000);
      expect(written.durationMs).toBeCloseTo(12_000, -2);
    });

    it('reads the built file rather than rebuilding when it is already there', async () => {
      // Arrange — the image-build case. A distinctive file proves which path
      // was taken: a rebuild would produce the Thue-Morse fixture mix instead.
      const dir = await scratchDir();
      const path = join(dir, 'longform.wav');
      const pcm = Buffer.alloc(16_000 * 2 * 3);
      pcm.writeInt16LE(12_345, 0);
      await writeFile(path, encodeWav(pcm, 16_000, 1));
      const clips = catalog({
        clipPaths: { harvard: HARVARD, apollo: APOLLO, longform: path },
      });

      // Act
      const chunks = await clips.load('longform');

      // Assert
      const totalMs = chunks.reduce((sum, chunk) => sum + chunk.durationMs, 0);
      expect(totalMs).toBeCloseTo(3_000, 0);
      expect(
        decodeWav(chunks[0]?.wav ?? Buffer.alloc(0)).pcm.readInt16LE(0),
      ).toBe(12_345);
    });

    it('still serves the clip when the built file cannot be cached', async () => {
      // Arrange — a read-only filesystem should cost the next restart a
      // rebuild, not the run the operator is waiting on. A path *below an
      // existing file* is the portable way to make the write fail: `mkdir` of
      // its parent is ENOTDIR on every platform.
      const clips = catalog({
        clipPaths: {
          harvard: HARVARD,
          apollo: APOLLO,
          longform: join(HARVARD, 'not-a-directory', 'longform.wav'),
        },
      });

      // Act
      const chunks = await clips.load('longform');

      // Assert
      expect(chunks.length).toBeGreaterThan(0);
    });
  });
});
