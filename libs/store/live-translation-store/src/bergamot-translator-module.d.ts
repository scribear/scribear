declare module '@browsermt/bergamot-translator/translator.js' {
  export interface TranslatorOptions {
    pivotLanguage?: string | null;
    registryUrl?: string;
    workerUrl?: string;
    downloadTimeout?: number;
    cacheSize?: number;
    useNativeIntGemm?: boolean;
    onerror?: (error: Error) => void;
  }

  export interface TranslationModelRef {
    from: string;
    to: string;
    [key: string]: unknown;
  }

  export interface BergamotWorkerHandle {
    worker: Worker;
    exports: Record<string, (...args: unknown[]) => Promise<unknown>>;
  }

  export class TranslatorBacking {
    constructor(options?: TranslatorOptions);
    options: TranslatorOptions;
    registryUrl: string;
    registry: Promise<TranslationModelRef[]>;
    loadModelRegistery(): Promise<TranslationModelRef[]>;
    loadTranslationModel(
      pair: { from: string; to: string },
      options?: { signal?: AbortSignal },
    ): Promise<{
      model: ArrayBuffer;
      shortlist: ArrayBuffer;
      vocabs: ArrayBuffer[];
      qualityModel?: ArrayBuffer;
      config?: Record<string, unknown>;
    }>;
    getModels(pair: {
      from: string;
      to: string;
    }): Promise<{ from: string; to: string }[]>;
    getTranslationModel(
      pair: { from: string; to: string },
      options?: { signal?: AbortSignal },
    ): Promise<{
      model: ArrayBuffer;
      shortlist: ArrayBuffer;
      vocabs: ArrayBuffer[];
      qualityModel?: ArrayBuffer;
      config?: Record<string, unknown>;
    }>;
    loadWorker(): Promise<BergamotWorkerHandle>;
  }

  export interface TranslationRequest {
    from: string;
    to: string;
    text: string;
    html?: boolean;
  }

  export interface TranslationResponse {
    request: TranslationRequest;
    source: { text: string };
    target: { text: string };
  }

  export class LatencyOptimisedTranslator {
    constructor(options?: TranslatorOptions, backing?: TranslatorBacking);
    worker: Promise<BergamotWorkerHandle> | null;
    translate(
      request: TranslationRequest,
      options?: { signal?: AbortSignal },
    ): Promise<TranslationResponse>;
    delete(): Promise<void>;
  }
}
