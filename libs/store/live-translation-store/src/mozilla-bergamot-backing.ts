import {
  type BergamotWorkerHandle,
  type TranslationModelRef,
  TranslatorBacking,
  type TranslatorOptions,
} from '@browsermt/bergamot-translator/translator.js';

const MOZILLA_REGISTRY_URL = '/mozilla-models/db/models.json';
const SAME_ORIGIN_MODEL_BASE_URL = '/mozilla-models';
const DEFAULT_CACHE_NAME = 'scribear-bergamot-models-v1';

interface FileRecord {
  path: string;
  uncompressedSize?: number;
  uncompressedHash?: string;
}

interface MozillaModel {
  architecture: string;
  releaseStatus: string | null;
  sourceLanguage: string;
  targetLanguage: string;
  files: {
    model: FileRecord;
    lexicalShortlist: FileRecord;
    vocab?: FileRecord;
    srcVocab?: FileRecord;
    trgVocab?: FileRecord;
    qualityModel?: FileRecord;
  };
}

interface MozillaRegistryResponse {
  models: Record<string, MozillaModel[]>;
}

export interface BrowserModel extends TranslationModelRef {
  from: string;
  to: string;
  architecture: string;
  modelBytes: number | null;
  record: MozillaModel;
  baseUrl: string;
}

export interface BergamotDownloadProgress {
  pair: { from: string; to: string };
  /** Progress for this one model, from zero through one. */
  fraction: number;
}

interface BackingOptions extends TranslatorOptions {
  workerUrl: string;
  cacheName?: string;
  onDownloadProgress?: (progress: BergamotDownloadProgress) => void;
}

type WorkerCall = (...args: unknown[]) => Promise<unknown>;

/** Converts BCP-47 tags used by the UI into Mozilla registry identifiers. */
export function toMozillaLanguage(language: string): string {
  const normalized = language.trim().toLowerCase().replaceAll('-', '_');
  if (normalized === 'zh_tw') return 'zh_hant';
  return normalized;
}

function releaseRank(model: MozillaModel): number {
  if (model.releaseStatus?.startsWith('Release') !== true) {
    return Number.MAX_SAFE_INTEGER;
  }

  const architectureRank: Record<string, number> = {
    'base-memory': 0,
    tiny: 1,
    base: 2,
  };
  const statusRank = model.releaseStatus === 'Release' ? 0 : 1;
  return (architectureRank[model.architecture] ?? 9) * 10 + statusRank;
}

async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

async function gunzip(data: ArrayBuffer): Promise<ArrayBuffer> {
  const stream = new Blob([data])
    .stream()
    .pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).arrayBuffer();
}

async function openCache(cacheName: string): Promise<Cache | null> {
  try {
    if (!('caches' in globalThis)) return null;
    return await caches.open(cacheName);
  } catch {
    // Private browsing and restrictive storage policies can reject Cache API
    // calls. Translation still works for that session; it just redownloads.
    return null;
  }
}

/**
 * Adapts Mozilla's current Firefox model registry to browsermt's older
 * registry contract and stores the compressed language packages in Cache
 * Storage. Model requests stay same-origin so this works in every browser;
 * Vite/nginx proxy the public Mozilla bucket under `/mozilla-models`.
 */
export class MozillaBergamotBacking extends TranslatorBacking {
  readonly cacheName: string;
  readonly workerScriptUrl: string;
  readonly onDownloadProgress:
    | ((progress: BergamotDownloadProgress) => void)
    | undefined;

  constructor(options: BackingOptions) {
    super({
      ...options,
      registryUrl: MOZILLA_REGISTRY_URL,
    });
    this.cacheName = options.cacheName ?? DEFAULT_CACHE_NAME;
    this.workerScriptUrl = options.workerUrl;
    this.onDownloadProgress = options.onDownloadProgress;
  }

  override async loadModelRegistery(): Promise<BrowserModel[]> {
    const response = await fetch(this.registryUrl, {
      credentials: 'omit',
    });
    if (!response.ok) {
      throw new Error(
        `Could not load Mozilla model registry (${String(response.status)})`,
      );
    }

    const registry = (await response.json()) as MozillaRegistryResponse;
    const baseUrl = new URL(
      SAME_ORIGIN_MODEL_BASE_URL,
      globalThis.location.origin,
    ).href;
    const selected = new Map<string, BrowserModel>();

    for (const candidates of Object.values(registry.models)) {
      for (const record of candidates) {
        if (record.releaseStatus?.startsWith('Release') !== true) continue;

        const key = `${record.sourceLanguage}:${record.targetLanguage}`;
        const current = selected.get(key);
        if (
          current === undefined ||
          releaseRank(record) < releaseRank(current.record)
        ) {
          selected.set(key, {
            from: record.sourceLanguage,
            to: record.targetLanguage,
            architecture: record.architecture,
            modelBytes: record.files.model.uncompressedSize ?? null,
            record,
            baseUrl,
          });
        }
      }
    }

    return [...selected.values()].sort((left, right) =>
      `${left.from}-${left.to}`.localeCompare(`${right.from}-${right.to}`),
    );
  }

  override async loadWorker(): Promise<BergamotWorkerHandle> {
    const worker = new Worker(this.workerScriptUrl);
    let serial = 0;
    const pending = new Map<
      number,
      { resolve: (result: unknown) => void; reject: (error: Error) => void }
    >();

    const call: WorkerCall = (name, ...args) =>
      new Promise((resolve, reject) => {
        const id = ++serial;
        pending.set(id, { resolve, reject });
        worker.postMessage({ id, name, args });
      });

    worker.addEventListener('message', (event) => {
      const data = event.data as {
        id: number;
        result?: unknown;
        error?: { message?: string; stack?: string };
      };
      const request = pending.get(data.id);
      if (request === undefined) return;
      pending.delete(data.id);

      if (data.error !== undefined) {
        const error = new Error(data.error.message ?? 'Bergamot worker failed');
        if (data.error.stack !== undefined) error.stack = data.error.stack;
        request.reject(error);
      } else {
        request.resolve(data.result);
      }
    });

    worker.addEventListener('error', (event) => {
      const error =
        event.error instanceof Error ? event.error : new Error(event.message);
      for (const request of pending.values()) request.reject(error);
      pending.clear();
      this.options.onerror?.(error);
    });

    try {
      // Only structured-cloneable values may cross the Worker boundary. The
      // upstream package sends callbacks too, which causes DataCloneError.
      await call('initialize', {
        cacheSize: this.options.cacheSize ?? 0,
        useNativeIntGemm: this.options.useNativeIntGemm ?? false,
      });
    } catch (error) {
      worker.terminate();
      throw error;
    }

    const exports = new Proxy<Record<string, WorkerCall>>(
      {},
      {
        get: (_target, property) => {
          if (property === 'then') return undefined;
          return (...args: unknown[]) => call(String(property), ...args);
        },
      },
    );

    return { worker, exports };
  }

  override async loadTranslationModel(
    pair: { from: string; to: string },
    options?: { signal?: AbortSignal },
  ): Promise<{
    model: ArrayBuffer;
    shortlist: ArrayBuffer;
    vocabs: ArrayBuffer[];
    qualityModel?: ArrayBuffer;
    config: Record<string, unknown>;
  }> {
    const entry = await this._findEntry(pair.from, pair.to);
    if (entry === undefined) {
      throw new Error(
        `No released Mozilla model for ${pair.from} → ${pair.to}`,
      );
    }

    const files = entry.record.files;
    const jobs: [string, FileRecord][] = [
      ['model', files.model],
      ['lexical shortlist', files.lexicalShortlist],
    ];
    if (files.vocab !== undefined) {
      jobs.push(['vocabulary', files.vocab]);
    } else if (files.srcVocab !== undefined && files.trgVocab !== undefined) {
      jobs.push(
        ['source vocabulary', files.srcVocab],
        ['target vocabulary', files.trgVocab],
      );
    } else {
      throw new Error(
        `Mozilla model ${pair.from} → ${pair.to} has no usable vocabulary`,
      );
    }
    if (files.qualityModel !== undefined) {
      jobs.push(['quality model', files.qualityModel]);
    }

    const fractions = jobs.map(() => 0);
    const loaded = new Map<string, ArrayBuffer>();
    await Promise.all(
      jobs.map(async ([label, file], index) => {
        const data = await this._loadFile(
          file,
          entry,
          options?.signal,
          (fraction) => {
            fractions[index] = fraction;
            this.onDownloadProgress?.({
              pair,
              fraction:
                fractions.reduce((sum, value) => sum + value, 0) /
                fractions.length,
            });
          },
        );
        loaded.set(label, data);
      }),
    );

    const model = loaded.get('model');
    const shortlist = loaded.get('lexical shortlist');
    if (model === undefined || shortlist === undefined) {
      throw new Error(`Mozilla model ${pair.from} → ${pair.to} is incomplete`);
    }

    const sharedVocab = loaded.get('vocabulary');
    const sourceVocab = loaded.get('source vocabulary');
    const targetVocab = loaded.get('target vocabulary');
    const vocabs =
      sharedVocab !== undefined
        ? [sharedVocab]
        : sourceVocab !== undefined && targetVocab !== undefined
          ? [sourceVocab, targetVocab]
          : [];
    if (vocabs.length === 0) {
      throw new Error(`Mozilla model ${pair.from} → ${pair.to} is incomplete`);
    }

    const qualityModel = loaded.get('quality model');
    return {
      model,
      shortlist,
      vocabs,
      ...(qualityModel === undefined ? {} : { qualityModel }),
      config: qualityModel === undefined ? {} : { 'skip-cost': false },
    };
  }

  async isPairCached(from: string, to: string): Promise<boolean> {
    const entry = await this._findEntry(from, to);
    const cache = await openCache(this.cacheName);
    if (entry === undefined || cache === null) return false;
    const matches = await Promise.all(
      this._fileUrls(entry).map((url) => cache.match(url)),
    );
    return matches.every((match) => match !== undefined);
  }

  private async _findEntry(
    from: string,
    to: string,
  ): Promise<BrowserModel | undefined> {
    return ((await this.registry) as BrowserModel[]).find(
      (model) => model.from === from && model.to === to,
    );
  }

  private _fileUrls(entry: BrowserModel): string[] {
    return Object.values(entry.record.files).map(
      (file) => new URL(file.path, `${entry.baseUrl}/`).href,
    );
  }

  private async _loadFile(
    file: FileRecord,
    entry: BrowserModel,
    signal: AbortSignal | undefined,
    reportFraction: (fraction: number) => void,
  ): Promise<ArrayBuffer> {
    const url = new URL(file.path, `${entry.baseUrl}/`).href;
    const compressed = await this._fetchCompressed(url, signal, reportFraction);
    const uncompressed = await gunzip(compressed);

    if (file.uncompressedHash !== undefined) {
      const digest = await sha256Hex(uncompressed);
      if (digest !== file.uncompressedHash) {
        const cache = await openCache(this.cacheName);
        await cache?.delete(url);
        throw new Error(`Checksum mismatch for ${entry.from} → ${entry.to}`);
      }
    }

    reportFraction(1);
    return uncompressed;
  }

  private async _fetchCompressed(
    url: string,
    signal: AbortSignal | undefined,
    reportFraction: (fraction: number) => void,
  ): Promise<ArrayBuffer> {
    const cache = await openCache(this.cacheName);
    const cached = await cache?.match(url);
    if (cached !== undefined) {
      reportFraction(1);
      return cached.arrayBuffer();
    }

    const response = await fetch(url, {
      credentials: 'omit',
      ...(signal === undefined ? {} : { signal }),
    });
    if (!response.ok) {
      throw new Error(
        `Could not download translation model (${String(response.status)})`,
      );
    }

    const compressed = await this._readWithProgress(response, reportFraction);
    try {
      await cache?.put(
        url,
        new Response(compressed, {
          headers: { 'content-type': 'application/gzip' },
        }),
      );
    } catch {
      // A storage quota failure must not discard a model already in memory.
    }
    return compressed;
  }

  private async _readWithProgress(
    response: Response,
    reportFraction: (fraction: number) => void,
  ): Promise<ArrayBuffer> {
    if (response.body === null) return response.arrayBuffer();

    const total = Number(response.headers.get('content-length'));
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let loaded = 0;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.byteLength;
      if (Number.isFinite(total) && total > 0) {
        reportFraction(Math.min(loaded / total, 0.99));
      }
    }

    const output = new Uint8Array(loaded);
    let offset = 0;
    for (const chunk of chunks) {
      output.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return output.buffer;
  }
}
