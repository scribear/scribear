import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { BaseLogger } from '@scribear/base-fastify-server';
import {
  type AudioChunk,
  type ClipId,
  decodeWav,
  sliceIntoChunks,
} from '@scribear/test-audio-source';

import {
  type LongformOptions,
  buildLongformWav,
} from '#src/server/shared/clips/longform.js';

/**
 * The clip catalog: turns a {@link ClipId} into chunks ready to stream.
 *
 * `params.ts` names three clips and says nothing about where they live —
 * deliberately, since paths are a deployment concern. This is where that is
 * decided, and it is also where a fixture in the wrong format is caught.
 */

export interface ClipCatalogConfig {
  /** Absolute path per clip id, as laid down by the Dockerfile. */
  clipPaths: Record<ClipId, string>;
  longform: LongformOptions;
  /** Chunk duration. 100 ms matches the kiosk's `AUDIO_CHUNK_MS`. */
  chunkMs: number;
  /**
   * The format every session's `transcriptionStreamConfig` declares. The
   * transcription service raises on a mismatch rather than resampling, so a
   * fixture at the wrong rate means every frame is rejected — caught here, at
   * load, rather than one frame at a time on the wire.
   */
  expectedSampleRate: number;
  expectedChannels: number;
}

export class ClipCatalogService {
  private _config: ClipCatalogConfig;
  private _logger: BaseLogger;
  private _chunks = new Map<ClipId, readonly AudioChunk[]>();
  /**
   * Loads currently in flight, keyed by clip.
   *
   * Both devices can be started on the same clip in the same instant, and
   * `longform` may have to be built on that first use. Without this they would
   * each build it, each write the file, and each pay the cost — and one of the
   * two writes would be racing the other's reader.
   */
  private _inFlight = new Map<ClipId, Promise<readonly AudioChunk[]>>();

  constructor(clipCatalogConfig: ClipCatalogConfig, logger: BaseLogger) {
    this._config = clipCatalogConfig;
    this._logger = logger;
  }

  /**
   * Chunks for `clip`, loading and slicing it once.
   *
   * Cached for the process lifetime: a clip is a few megabytes, there are three
   * of them, and re-slicing five minutes of audio every time an operator
   * presses start would put the cost inside the window the run manager reports
   * as `connecting`.
   */
  async load(clip: ClipId): Promise<readonly AudioChunk[]> {
    const cached = this._chunks.get(clip);
    if (cached !== undefined) return cached;

    const pending = this._inFlight.get(clip);
    if (pending !== undefined) return pending;

    const load = this._load(clip)
      .then((chunks) => {
        this._chunks.set(clip, chunks);
        return chunks;
      })
      .finally(() => {
        this._inFlight.delete(clip);
      });
    this._inFlight.set(clip, load);
    return load;
  }

  private async _load(clip: ClipId): Promise<readonly AudioChunk[]> {
    const path = this._config.clipPaths[clip];
    const raw =
      clip === 'longform'
        ? await this._readOrBuildLongform(path)
        : await readFile(path);

    const wav = decodeWav(raw);
    if (wav.sampleRate !== this._config.expectedSampleRate) {
      throw new Error(
        `Clip "${clip}" is ${String(wav.sampleRate)} Hz but sessions expect ${String(this._config.expectedSampleRate)} Hz; the transcription service would reject every frame.`,
      );
    }
    if (wav.channels !== this._config.expectedChannels) {
      throw new Error(
        `Clip "${clip}" has ${String(wav.channels)} channel(s) but sessions expect ${String(this._config.expectedChannels)}.`,
      );
    }

    const chunks = sliceIntoChunks(wav, this._config.chunkMs);
    this._logger.info(
      {
        clip,
        path,
        durationMs: Math.round(wav.durationMs),
        chunks: chunks.length,
      },
      'test-audio clip loaded',
    );
    return chunks;
  }

  /**
   * Reads the longform clip, building it if the image did not.
   *
   * The Dockerfile builds it once at image-build time, where a download can be
   * attempted with a network. This is the second chance: a local `npm run dev`,
   * a bind mount that shadowed the file, or an image built before the build
   * step existed. Building on first use costs one operator a few seconds of
   * `connecting`, which is a far better failure than the clip the SPA offers
   * being permanently unusable.
   */
  private async _readOrBuildLongform(path: string): Promise<Buffer> {
    try {
      return await readFile(path);
    } catch {
      this._logger.warn(
        { path },
        'longform clip missing; building it now (the image build normally does this)',
      );
    }

    const built = await buildLongformWav(this._config.longform);
    this._logger.info(
      { path, source: built.source, note: built.note },
      'longform clip built',
    );

    // Best effort. A read-only or non-writable filesystem costs the next
    // restart a rebuild, not the run the operator is waiting on.
    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, built.wav);
    } catch (err) {
      this._logger.warn(
        { err, path },
        'could not cache the longform clip to disk',
      );
    }
    return built.wav;
  }
}
