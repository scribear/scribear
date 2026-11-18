/**
 * Common interface for the local Bergamot runtime and the W3C Translator API.
 *
 * @see https://webmachinelearning.github.io/translation-api/
 *
 * These are declared locally rather than pulled from `@types/dom-chromium-ai`
 * so the rest of the codebase never sees a global `Translator` it might use
 * without a support check. Everything reaching the API goes through
 * {@link getTranslatorApi}, which returns `null` on browsers without it.
 */

/** Readiness of a language pair, per the spec's `Availability` enum. */
export type TranslatorAvailability =
  | 'unavailable'
  | 'downloadable'
  | 'downloading'
  | 'available';

/** Progress reporter handed to `create()`'s `monitor` callback. */
export interface TranslatorCreateMonitor {
  addEventListener: (
    type: 'downloadprogress',
    listener: (event: { loaded: number }) => void,
  ) => void;
}

/** Options accepted by `Translator.create()`. */
export interface TranslatorCreateOptions {
  sourceLanguage: string;
  targetLanguage: string;
  signal?: AbortSignal;
  monitor?: (monitor: TranslatorCreateMonitor) => void;
}

/** A live translator bound to one language pair. */
export interface TranslatorInstance {
  translate: (
    input: string,
    options?: { signal?: AbortSignal },
  ) => Promise<string>;
  destroy: () => void;
  readonly sourceLanguage: string;
  readonly targetLanguage: string;
}

/** The static half of a translation provider. */
export interface TranslatorApi {
  availability: (options: {
    sourceLanguage: string;
    targetLanguage: string;
  }) => Promise<TranslatorAvailability>;
  create: (options: TranslatorCreateOptions) => Promise<TranslatorInstance>;
}

/**
 * Loads Bergamot lazily. Keeping this import behind the browser capability
 * check matters in tests and server-side tooling: browsermt installs a Node
 * Worker shim as a module side effect when no browser Worker exists.
 *
 * The native API remains a fallback for Chromium and for deployments that
 * have not configured the `/mozilla-models` proxy yet.
 */
let bergamotApiPromise: Promise<TranslatorApi> | null = null;

function loadBergamotApi(): Promise<TranslatorApi> {
  bergamotApiPromise ??= import('./bergamot-translator-api.js').then(
    ({ bergamotTranslatorApi }) => bergamotTranslatorApi,
  );
  return bergamotApiPromise;
}

function getNativeTranslatorApi(): TranslatorApi | null {
  try {
    const candidate = (globalThis as { Translator?: unknown }).Translator;
    if (typeof candidate !== 'object' && typeof candidate !== 'function') {
      return null;
    }
    if (candidate === null) return null;
    const api = candidate as Partial<TranslatorApi>;
    if (
      typeof api.availability !== 'function' ||
      typeof api.create !== 'function'
    ) {
      return null;
    }
    return api as TranslatorApi;
  } catch {
    return null;
  }
}

function isBergamotRuntimeSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.Worker === 'function' &&
    typeof WebAssembly === 'object' &&
    typeof fetch === 'function' &&
    typeof DecompressionStream === 'function' &&
    typeof crypto.subtle === 'object'
  );
}

function createPreferredApi(nativeApi: TranslatorApi | null): TranslatorApi {
  return {
    availability: async (options) => {
      try {
        const bergamotApi = await loadBergamotApi();
        const availability = await bergamotApi.availability(options);
        if (availability !== 'unavailable') return availability;
      } catch {
        // A missing proxy or failed registry request can still use Chromium's
        // built-in model when the browser provides one.
      }
      return nativeApi?.availability(options) ?? 'unavailable';
    },
    create: async (options) => {
      try {
        const bergamotApi = await loadBergamotApi();
        const availability = await bergamotApi.availability(options);
        if (availability !== 'unavailable') {
          return await bergamotApi.create(options);
        }
      } catch (error) {
        if (nativeApi === null) throw error;
      }

      if (nativeApi !== null) return nativeApi.create(options);
      throw new Error(
        `No local translation model is available for ${options.sourceLanguage} → ${options.targetLanguage}`,
      );
    },
  };
}

export function getTranslatorApi(): TranslatorApi | null {
  const nativeApi = getNativeTranslatorApi();
  return isBergamotRuntimeSupported()
    ? createPreferredApi(nativeApi)
    : nativeApi;
}

/**
 * Whether this browser can run either Bergamot/WASM or its native Translator.
 */
export function isTranslatorApiSupported(): boolean {
  return getTranslatorApi() !== null;
}
