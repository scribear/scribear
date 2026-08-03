/**
 * Test harness page for `tools/translation-e2e`.
 *
 * Bundled by the e2e script and served over `http://localhost`, so the real
 * `TranslationService` runs against Chrome's real Translator API in a secure
 * context. Everything the e2e script needs is hung off `window` - there is no
 * UI here beyond the button, because the button is the point: `create()`
 * requires user activation, and only a real click provides it.
 */
import {
  type TranslatedSegment,
  TranslationService,
  type TranslationServiceState,
  getTranslatorApi,
} from '@scribear/live-translation-store';

declare global {
  interface Window {
    __harness: Harness;
  }
}

interface Harness {
  service: TranslationService;
  state: TranslationServiceState;
  segments: TranslatedSegment[];
  /** Anything thrown at the page: an empty list is itself an assertion. */
  pageErrors: string[];
  /** Language to enable on the next click. */
  targetLanguage: string;
  probeLanguages: () => Promise<unknown>;
  submit: (text: string) => void;
  disable: () => void;
  reset: () => void;
  /**
   * Slows every real `translate()` call by `ms`, keeping the real model
   * underneath. This is how the backpressure and timeout paths are exercised
   * against real Chrome: they only trigger when translation cannot keep up,
   * and a warm en-es model on a desktop never falls behind on its own.
   */
  setArtificialDelayMs: (ms: number) => void;
}

let artificialDelayMs = 0;

// Wrap the real API rather than replace it: `translate()` still goes to
// Chrome's on-device model, it just arrives late.
const realApi = getTranslatorApi();
if (realApi) {
  const realCreate = realApi.create.bind(realApi);
  (globalThis as unknown as { Translator: typeof realApi }).Translator = {
    availability: realApi.availability.bind(realApi),
    create: async (options) => {
      const translator = await realCreate(options);
      const realTranslate = translator.translate.bind(translator);
      return {
        ...translator,
        sourceLanguage: translator.sourceLanguage,
        targetLanguage: translator.targetLanguage,
        destroy: () => {
          translator.destroy();
        },
        translate: async (input, translateOptions) => {
          if (artificialDelayMs > 0) {
            await new Promise<void>((resolve, reject) => {
              const timer = setTimeout(resolve, artificialDelayMs);
              translateOptions?.signal?.addEventListener('abort', () => {
                clearTimeout(timer);
                const error = new Error('signal is aborted without reason');
                error.name = 'AbortError';
                reject(error);
              });
            });
          }
          return realTranslate(input, translateOptions);
        },
      };
    },
  };
}

const service = new TranslationService();

const harness: Harness = {
  service,
  state: service.state,
  segments: [],
  pageErrors: [],
  targetLanguage: 'es',
  probeLanguages: () => service.probeLanguages(),
  submit: (text) => {
    service.submit(text);
  },
  disable: () => {
    service.disable();
  },
  reset: () => {
    service.reset();
  },
  setArtificialDelayMs: (ms) => {
    artificialDelayMs = ms;
  },
};
window.__harness = harness;

service.on('stateChange', (state) => {
  harness.state = state;
});
service.on('segment', (segment) => {
  harness.segments.push(segment);
});
service.on('cleared', () => {
  harness.segments = [];
});

window.addEventListener('error', (event) => {
  harness.pageErrors.push(`error: ${event.message}`);
});
window.addEventListener('unhandledrejection', (event) => {
  harness.pageErrors.push(`unhandledrejection: ${String(event.reason)}`);
});

const enableButton = document.getElementById('enable');
enableButton?.addEventListener('click', () => {
  void service.enable(harness.targetLanguage);
});

document.getElementById('ready')?.setAttribute('data-ready', 'true');
