import type {
  TranslatorApi,
  TranslatorAvailability,
  TranslatorCreateOptions,
  TranslatorInstance,
} from '#src/translator-api.js';

/**
 * Behaviour knobs for {@link installFakeTranslatorApi}.
 */
export interface FakeTranslatorOptions {
  /** Availability per target language. Anything unlisted is `downloadable`. */
  availability?: Record<string, TranslatorAvailability>;
  /** Make `create()` reject with an error of this `name`. */
  createFailsWith?: string | undefined;
  /** Emit these `downloadprogress` values before `create()` resolves. */
  downloadProgress?: number[];
  /** How long each `translate()` takes, in fake-timer milliseconds. */
  translateDelayMs?: number;
  /** Make `translate()` reject with an error of this `name`; `undefined` heals it. */
  translateFailsWith?: string | undefined;
}

/**
 * A scriptable stand-in for `self.Translator`.
 *
 * The real API cannot run under jsdom - it needs Chrome's on-device model - so
 * unit tests drive this instead, and a separate real-Chrome end-to-end check
 * (`tools/translation-e2e`) pins the assumptions encoded here against the
 * actual browser.
 */
export interface FakeTranslatorApi {
  api: TranslatorApi;
  /** Every string passed to `translate()`, in order. */
  translateCalls: string[];
  /** Every language pair passed to `create()`. */
  createCalls: { sourceLanguage: string; targetLanguage: string }[];
  /** Number of live (created but not destroyed) translators. */
  liveTranslators: number;
  /** Replace behaviour mid-test. */
  configure: (options: FakeTranslatorOptions) => void;
  /** Remove the fake from `globalThis`. */
  uninstall: () => void;
}

/**
 * Installs a fake Translator API onto `globalThis` and returns handles for
 * asserting on it. Call `uninstall()` in an `afterEach`.
 */
export function installFakeTranslatorApi(
  initialOptions: FakeTranslatorOptions = {},
): FakeTranslatorApi {
  let options: FakeTranslatorOptions = { ...initialOptions };

  const handle: FakeTranslatorApi = {
    api: undefined as unknown as TranslatorApi,
    translateCalls: [],
    createCalls: [],
    liveTranslators: 0,
    configure: (next) => {
      options = { ...options, ...next };
    },
    uninstall: () => {
      delete (globalThis as { Translator?: unknown }).Translator;
    },
  };

  const api: TranslatorApi = {
    availability: ({ targetLanguage }) =>
      Promise.resolve(options.availability?.[targetLanguage] ?? 'downloadable'),

    create: async (createOptions: TranslatorCreateOptions) => {
      handle.createCalls.push({
        sourceLanguage: createOptions.sourceLanguage,
        targetLanguage: createOptions.targetLanguage,
      });

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

      handle.liveTranslators += 1;
      let destroyed = false;

      const translator: TranslatorInstance = {
        sourceLanguage: createOptions.sourceLanguage,
        targetLanguage: createOptions.targetLanguage,
        destroy: () => {
          if (!destroyed) {
            destroyed = true;
            handle.liveTranslators -= 1;
          }
        },
        translate: async (input, translateOptions) => {
          handle.translateCalls.push(input);

          if (options.translateFailsWith !== undefined) {
            const error = new Error('fake translate failure');
            error.name = options.translateFailsWith;
            throw error;
          }

          const delay = options.translateDelayMs ?? 0;
          if (delay > 0) {
            await new Promise<void>((resolve, reject) => {
              const timer = setTimeout(resolve, delay);
              translateOptions?.signal?.addEventListener('abort', () => {
                clearTimeout(timer);
                const error = new Error('signal is aborted without reason');
                error.name = 'AbortError';
                reject(error);
              });
            });
          }

          if (translateOptions?.signal?.aborted === true) {
            const error = new Error('signal is aborted without reason');
            error.name = 'AbortError';
            throw error;
          }
          return `[${createOptions.targetLanguage}] ${input}`;
        },
      };
      return translator;
    },
  };

  handle.api = api;
  (globalThis as { Translator?: unknown }).Translator = api;
  return handle;
}
