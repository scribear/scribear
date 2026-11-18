import { LatencyOptimisedTranslator } from '@browsermt/bergamot-translator/translator.js';

import {
  MozillaBergamotBacking,
  toMozillaLanguage,
} from './mozilla-bergamot-backing.js';
import type {
  TranslatorApi,
  TranslatorCreateOptions,
  TranslatorInstance,
} from './translator-api.js';

const WORKER_FILENAME = 'bergamot/translator-worker.js';

function workerScriptUrl(): string {
  // `base: './'` lets the same bundles run at /client/, /kiosk/, and Vite's
  // root. Resolve the worker beside the current app rather than at `/`.
  return new URL(WORKER_FILENAME, document.baseURI).href;
}

function createBacking(
  onDownloadProgress?: (pairFraction: number) => void,
): MozillaBergamotBacking {
  return new MozillaBergamotBacking({
    workerUrl: workerScriptUrl(),
    pivotLanguage: 'en',
    downloadTimeout: 180_000,
    cacheSize: 4096,
    ...(onDownloadProgress === undefined
      ? {}
      : {
          onDownloadProgress: ({ fraction }) => {
            onDownloadProgress(fraction);
          },
        }),
  });
}

class BergamotTranslatorInstance implements TranslatorInstance {
  readonly sourceLanguage: string;
  readonly targetLanguage: string;
  readonly #sourceModelLanguage: string;
  readonly #targetModelLanguage: string;
  readonly #translator: LatencyOptimisedTranslator;
  #destroyed = false;

  constructor(
    sourceLanguage: string,
    targetLanguage: string,
    translator: LatencyOptimisedTranslator,
  ) {
    this.sourceLanguage = sourceLanguage;
    this.targetLanguage = targetLanguage;
    this.#sourceModelLanguage = toMozillaLanguage(sourceLanguage);
    this.#targetModelLanguage = toMozillaLanguage(targetLanguage);
    this.#translator = translator;
  }

  async translate(
    input: string,
    options?: { signal?: AbortSignal },
  ): Promise<string> {
    if (this.#destroyed) throw new Error('Translator has been destroyed');
    const response = await this.#translator.translate(
      {
        from: this.#sourceModelLanguage,
        to: this.#targetModelLanguage,
        text: input,
        html: false,
      },
      options,
    );
    return response.target.text;
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    void this.#translator.delete();
  }
}

class BergamotTranslatorApi implements TranslatorApi {
  readonly #catalog = createBacking();

  async availability({
    sourceLanguage,
    targetLanguage,
  }: {
    sourceLanguage: string;
    targetLanguage: string;
  }): Promise<'unavailable' | 'downloadable' | 'available'> {
    const from = toMozillaLanguage(sourceLanguage);
    const to = toMozillaLanguage(targetLanguage);

    try {
      const models = await this.#catalog.getModels({ from, to });
      const cached = await Promise.all(
        models.map((pair) => this.#catalog.isPairCached(pair.from, pair.to)),
      );
      return cached.every(Boolean) ? 'available' : 'downloadable';
    } catch {
      return 'unavailable';
    }
  }

  async create(options: TranslatorCreateOptions): Promise<TranslatorInstance> {
    const from = toMozillaLanguage(options.sourceLanguage);
    const to = toMozillaLanguage(options.targetLanguage);
    const listeners = new Set<(event: { loaded: number }) => void>();
    options.monitor?.({
      addEventListener: (_type, listener) => {
        listeners.add(listener);
      },
    });

    let modelIndex = 0;
    let modelCount = 1;
    let lastProgress = 0;
    const reportProgress = (modelFraction: number): void => {
      const progress = Math.max(
        lastProgress,
        Math.min((modelIndex + modelFraction) / modelCount, 1),
      );
      lastProgress = progress;
      for (const listener of listeners) listener({ loaded: progress });
    };

    let needsDownload = false;
    const backing = createBacking((fraction) => {
      if (needsDownload) reportProgress(fraction);
    });
    const models = await backing.getModels({ from, to });
    modelCount = models.length;

    const cached = await Promise.all(
      models.map((pair) => backing.isPairCached(pair.from, pair.to)),
    );
    needsDownload = cached.some((value) => !value);
    if (needsDownload) reportProgress(0);

    for (const [index, pair] of models.entries()) {
      modelIndex = index;
      await backing.getTranslationModel(pair, {
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      if (needsDownload) reportProgress(1);
    }

    const translator = new LatencyOptimisedTranslator(backing.options, backing);
    try {
      // Fail create() immediately if the WASM runtime or worker cannot start,
      // instead of returning an instance whose first translation hangs.
      await translator.worker;
    } catch (error) {
      await translator.delete();
      throw error;
    }

    return new BergamotTranslatorInstance(
      options.sourceLanguage,
      options.targetLanguage,
      translator,
    );
  }
}

export const bergamotTranslatorApi: TranslatorApi = new BergamotTranslatorApi();
