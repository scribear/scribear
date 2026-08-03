/**
 * Minimal typings for the W3C Translator API (Chrome 138+, Edge 138+).
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

/** The static half of the API, exposed as `self.Translator`. */
export interface TranslatorApi {
  availability: (options: {
    sourceLanguage: string;
    targetLanguage: string;
  }) => Promise<TranslatorAvailability>;
  create: (options: TranslatorCreateOptions) => Promise<TranslatorInstance>;
}

/**
 * Returns `self.Translator` if this browser exposes it, else `null`.
 *
 * Reading it is wrapped because the property lives behind a secure-context
 * check and, in sandboxed or policy-restricted frames, touching an absent
 * global through a `Proxy`-based polyfill can throw rather than be `undefined`.
 * A caption view must never fail to render because a browser feature probe
 * threw.
 */
export function getTranslatorApi(): TranslatorApi | null {
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

/**
 * Whether in-browser translation is even worth offering to this user. Callers
 * use this to hide the whole feature - button, menu and dialogs - rather than
 * show controls that can only fail.
 */
export function isTranslatorApiSupported(): boolean {
  return getTranslatorApi() !== null;
}
