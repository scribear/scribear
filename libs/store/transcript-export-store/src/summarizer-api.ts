/**
 * Minimal typings for the W3C Summarizer API (Chrome 138+).
 *
 * @see https://webmachinelearning.github.io/writing-assistance-apis/
 *
 * Declared locally, like the Translator typings in `@scribear/live-translation-store`,
 * so nothing in the codebase can reach a global `Summarizer` without going
 * through {@link getSummarizerApi} and its support check.
 *
 * Unlike the Translator, this API is backed by Gemini Nano - a ~1.8 GB
 * foundation model needing roughly 22 GB of free disk, and a real, enforced
 * token quota. Both facts shape everything built on top of it.
 */

/** Readiness of the model, per the spec's `Availability` enum. */
export type SummarizerAvailability =
  | 'unavailable'
  | 'downloadable'
  | 'downloading'
  | 'available';

/** Progress reporter handed to `create()`'s `monitor` callback. */
export interface SummarizerCreateMonitor {
  addEventListener: (
    type: 'downloadprogress',
    listener: (event: { loaded: number }) => void,
  ) => void;
}

/** The subset of `SummarizerCreateCoreOptions` this codebase uses. */
export interface SummarizerCoreOptions {
  type?: 'tldr' | 'teaser' | 'key-points' | 'headline';
  format?: 'plain-text' | 'markdown';
  length?: 'short' | 'medium' | 'long';
  expectedInputLanguages?: string[];
  outputLanguage?: string;
}

/** Options accepted by `Summarizer.create()`. */
export interface SummarizerCreateOptions extends SummarizerCoreOptions {
  sharedContext?: string;
  signal?: AbortSignal;
  monitor?: (monitor: SummarizerCreateMonitor) => void;
}

/** A live summarizer instance. */
export interface SummarizerInstance {
  summarize: (
    input: string,
    options?: { context?: string; signal?: AbortSignal },
  ) => Promise<string>;
  measureInputUsage: (
    input: string,
    options?: { context?: string; signal?: AbortSignal },
  ) => Promise<number>;
  destroy: () => void;
  /** Real and enforced - 9216 tokens in Chrome 150, not `null` as for Translator. */
  readonly inputQuota: number;
}

/** The static half of the API, exposed as `self.Summarizer`. */
export interface SummarizerApi {
  availability: (
    options?: SummarizerCoreOptions,
  ) => Promise<SummarizerAvailability>;
  create: (options?: SummarizerCreateOptions) => Promise<SummarizerInstance>;
}

/**
 * Returns `self.Summarizer` if this browser exposes it, else `null`.
 *
 * Reading it is wrapped for the same reason as the Translator's: a summary
 * button is a convenience, and a feature probe must never be the thing that
 * stops the transcript rendering.
 */
export function getSummarizerApi(): SummarizerApi | null {
  try {
    const candidate = (globalThis as { Summarizer?: unknown }).Summarizer;
    if (candidate === null || candidate === undefined) return null;
    if (typeof candidate !== 'object' && typeof candidate !== 'function') {
      return null;
    }
    const api = candidate as Partial<SummarizerApi>;
    if (
      typeof api.availability !== 'function' ||
      typeof api.create !== 'function'
    ) {
      return null;
    }
    return api as SummarizerApi;
  } catch {
    return null;
  }
}

/**
 * Whether summarization is worth offering at all. Note that this being true is
 * *not* enough to show the button: the API is present on machines whose
 * hardware cannot run Gemini Nano, where `availability()` answers
 * `'unavailable'` and `create()` throws "the service is not running".
 */
export function isSummarizerApiSupported(): boolean {
  return getSummarizerApi() !== null;
}
