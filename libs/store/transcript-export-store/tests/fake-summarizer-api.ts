import type {
  SummarizerApi,
  SummarizerAvailability,
  SummarizerCreateOptions,
  SummarizerInstance,
} from '#src/summarizer-api.js';

/**
 * Chrome's real quota, and the token cost measured from real inputs:
 * `tokens ~= 560 + 0.209 * chars` (fitted to 903/4515/8987/44806-char samples
 * in `tools/browser-ai/WebAPISummarizer-Dev.md`).
 *
 * The fake enforces this rather than a round number so a chunk size that would
 * blow the real quota fails here too.
 */
export const REAL_INPUT_QUOTA = 9216;
const TOKENS_PER_CHAR = 0.209;
const TOKEN_OVERHEAD = 560;

export function measuredTokens(chars: number): number {
  return Math.round(TOKEN_OVERHEAD + TOKENS_PER_CHAR * chars);
}

/** The largest input that fits the real quota, in characters. */
export const QUOTA_CHAR_LIMIT = Math.floor(
  (REAL_INPUT_QUOTA - TOKEN_OVERHEAD) / TOKENS_PER_CHAR,
);

/**
 * Behaviour knobs for {@link installFakeSummarizerApi}.
 */
export interface FakeSummarizerOptions {
  availability?: SummarizerAvailability;
  /** Make `create()` reject with an error of this `name`. */
  createFailsWith?: string | undefined;
  /** Make `summarize()` reject with an error of this `name`. */
  summarizeFailsWith?: string | undefined;
  /** Emit these `downloadprogress` values before `create()` resolves. */
  downloadProgress?: number[];
  /** How long each `summarize()` takes, in fake-timer milliseconds. */
  summarizeDelayMs?: number;
  /**
   * Produces the summary for an input. Defaults to a compressing summary; pass
   * a non-compressing one to exercise the non-convergence guard.
   */
  summarizeWith?: (input: string) => string;
}

/**
 * A scriptable stand-in for `self.Summarizer` that enforces the real quota.
 *
 * The real API needs Gemini Nano and cannot run under jsdom, so unit tests
 * drive this. `tools/transcript-export-e2e` pins the assumptions against real
 * Chrome where the hardware allows it.
 */
export interface FakeSummarizerApi {
  translateNothing?: never;
  /** Every input passed to `summarize()`, in order. */
  summarizeCalls: string[];
  /** Number of live (created but not destroyed) summarizers. */
  liveSummarizers: number;
  configure: (options: FakeSummarizerOptions) => void;
  uninstall: () => void;
}

/** Default: compress to ~25% of the input, at word boundaries. */
function compressingSummary(input: string): string {
  const words = input.trim().split(/\s+/);
  const kept = words.slice(0, Math.max(4, Math.ceil(words.length / 4)));
  return `- ${kept.join(' ')}`;
}

/**
 * Installs a fake Summarizer API onto `globalThis`. Call `uninstall()` in an
 * `afterEach`.
 */
export function installFakeSummarizerApi(
  initialOptions: FakeSummarizerOptions = {},
): FakeSummarizerApi {
  let options: FakeSummarizerOptions = { ...initialOptions };

  const handle: FakeSummarizerApi = {
    summarizeCalls: [],
    liveSummarizers: 0,
    configure: (next) => {
      options = { ...options, ...next };
    },
    uninstall: () => {
      delete (globalThis as { Summarizer?: unknown }).Summarizer;
    },
  };

  const abortError = () => {
    const error = new Error('signal is aborted without reason');
    error.name = 'AbortError';
    return error;
  };

  const api: SummarizerApi = {
    availability: () => Promise.resolve(options.availability ?? 'available'),

    create: async (createOptions: SummarizerCreateOptions = {}) => {
      if (createOptions.monitor) {
        createOptions.monitor({
          addEventListener: (_type, listener) => {
            for (const loaded of options.downloadProgress ?? []) {
              listener({ loaded });
            }
          },
        });
      }

      if (options.createFailsWith !== undefined) {
        const error = new Error('fake create failure');
        error.name = options.createFailsWith;
        throw error;
      }
      if (createOptions.signal?.aborted === true) throw abortError();

      handle.liveSummarizers += 1;
      let destroyed = false;

      const summarizer: SummarizerInstance = {
        inputQuota: REAL_INPUT_QUOTA,
        destroy: () => {
          if (!destroyed) {
            destroyed = true;
            handle.liveSummarizers -= 1;
          }
        },
        measureInputUsage: (input) =>
          Promise.resolve(measuredTokens(input.length)),
        summarize: async (input, summarizeOptions) => {
          handle.summarizeCalls.push(input);

          if (options.summarizeFailsWith !== undefined) {
            const error = new Error('fake summarize failure');
            error.name = options.summarizeFailsWith;
            throw error;
          }

          // The real quota, really enforced.
          if (measuredTokens(input.length) > REAL_INPUT_QUOTA) {
            const error = new Error('The input is too large.');
            error.name = 'QuotaExceededError';
            throw error;
          }

          const delay = options.summarizeDelayMs ?? 0;
          if (delay > 0) {
            await new Promise<void>((resolve, reject) => {
              const timer = setTimeout(resolve, delay);
              summarizeOptions?.signal?.addEventListener('abort', () => {
                clearTimeout(timer);
                reject(abortError());
              });
            });
          }
          if (summarizeOptions?.signal?.aborted === true) throw abortError();

          return (options.summarizeWith ?? compressingSummary)(input);
        },
      };
      return summarizer;
    },
  };

  (globalThis as { Summarizer?: unknown }).Summarizer = api;
  return handle;
}
