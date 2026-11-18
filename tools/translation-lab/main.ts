import {
  type TranslatedSegment,
  type TranslationLanguageOption,
  TranslationService,
  TranslationStatus,
} from '@scribear/live-translation-store';

type SpeechAvailability =
  | 'unavailable'
  | 'downloadable'
  | 'downloading'
  | 'available';

interface SpeechRecognitionOptions {
  langs: string[];
  processLocally: boolean;
  quality?: 'command' | 'dictation' | 'conversation';
}

interface SpeechRecognitionResultLike {
  isFinal: boolean;
  0: { transcript: string; confidence: number };
}

interface SpeechRecognitionResultEventLike extends Event {
  resultIndex: number;
  results: ArrayLike<SpeechRecognitionResultLike>;
}

interface SpeechRecognitionErrorEventLike extends Event {
  error: string;
  message?: string;
}

interface BrowserSpeechRecognition extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  processLocally?: boolean;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onresult: ((event: SpeechRecognitionResultEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
}

interface SpeechRecognitionConstructor {
  new (): BrowserSpeechRecognition;
  available?: (
    options: SpeechRecognitionOptions,
  ) => Promise<SpeechAvailability>;
  install?: (options: SpeechRecognitionOptions) => Promise<boolean>;
}

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  }
}

interface TestCase {
  name: string;
  input: string;
}

const TEST_CASES: readonly TestCase[] = [
  {
    name: 'Ordinary lecture sentence',
    input:
      'Welcome to ScribeAR. The lecture begins at ten thirty this morning.',
  },
  {
    name: 'Numbers and room names',
    input:
      'The temperature is 72.5 degrees, and room B-214 is on the second floor.',
  },
  {
    name: 'Punctuation and question',
    input:
      'Before we continue, can everyone see the three diagrams on the screen?',
  },
  {
    name: 'URL and email',
    input:
      'Please send questions to help@example.com and visit https://example.com after class.',
  },
];

const LIVE_CAPTION_SCRIPT: readonly string[] = [
  'Good morning everyone.',
  'Today we will discuss neural machine translation.',
  'The translation runs locally in your browser.',
  'The original English captions remain visible.',
];

function element(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`Missing #${id}`);
  return found;
}

const targetLanguage = element('target-language') as HTMLSelectElement;
const prepareTranslation = element('prepare-translation') as HTMLButtonElement;
const translationStatus = element('translation-status');
const translationDetail = element('translation-detail') as HTMLParagraphElement;
const translationProgressRow = element(
  'translation-progress-row',
) as HTMLDivElement;
const translationProgress = element(
  'translation-progress',
) as HTMLProgressElement;
const translationProgressLabel = element('translation-progress-label');
const manualInput = element('manual-input') as HTMLTextAreaElement;
const translateManual = element('translate-manual') as HTMLButtonElement;
const runCases = element('run-cases') as HTMLButtonElement;
const simulateLive = element('simulate-live') as HTMLButtonElement;
const startSpeech = element('start-speech') as HTMLButtonElement;
const stopSpeech = element('stop-speech') as HTMLButtonElement;
const localSpeechOnly = element('local-speech-only') as HTMLInputElement;
const speechStatus = element('speech-status');
const speechFinal = element('speech-final') as HTMLParagraphElement;
const speechInterim = element('speech-interim') as HTMLParagraphElement;
const results = element('results') as HTMLDivElement;
const clearResults = element('clear-results') as HTMLButtonElement;

const service = new TranslationService();
let translationReady = false;
let activeRecognition: BrowserSpeechRecognition | null = null;

interface SegmentWaiter {
  resolve: (segment: TranslatedSegment) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const segmentWaiters: SegmentWaiter[] = [];

function setStatus(
  node: HTMLSpanElement,
  label: string,
  tone: 'idle' | 'busy' | 'ready' | 'error',
): void {
  node.textContent = label;
  node.dataset['tone'] = tone;
}

function setTranslationActions(enabled: boolean): void {
  translationReady = enabled;
  translateManual.disabled = !enabled;
  runCases.disabled = !enabled;
  simulateLive.disabled = !enabled;
  startSpeech.disabled = !enabled || getSpeechConstructor() === null;
}

function clearEmptyState(): void {
  results.querySelector('.empty')?.remove();
}

function appendResult(
  source: string,
  translated: string,
  meta: string,
  passed = true,
): void {
  clearEmptyState();
  const row = document.createElement('article');
  row.className = 'result';
  row.dataset['result'] = passed ? 'pass' : 'fail';

  const sourceNode = document.createElement('p');
  sourceNode.className = 'source';
  sourceNode.textContent = source;

  const translatedNode = document.createElement('p');
  translatedNode.className = 'translated';
  translatedNode.textContent = translated;

  const metaNode = document.createElement('p');
  metaNode.className = 'meta';
  metaNode.textContent = meta;

  row.append(sourceNode, translatedNode, metaNode);
  results.prepend(row);
}

function getSpeechConstructor(): SpeechRecognitionConstructor | null {
  return window.SpeechRecognition ?? window.webkitSpeechRecognition ?? null;
}

function waitForSegment(text: string): Promise<TranslatedSegment> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const index = segmentWaiters.findIndex(
        (waiter) => waiter.resolve === resolve,
      );
      if (index >= 0) segmentWaiters.splice(index, 1);
      reject(new Error(`Translation timed out for: ${text}`));
    }, 25_000);
    segmentWaiters.push({ resolve, reject, timer });
    service.submit(text);
  });
}

async function translateOne(
  source: string,
  label = 'manual',
): Promise<TranslatedSegment> {
  if (!translationReady) throw new Error('Prepare a translation model first');
  const startedAt = performance.now();
  const segment = await waitForSegment(source);
  const elapsed = Math.round(performance.now() - startedAt);
  appendResult(
    source,
    segment.text,
    `${label} · ${String(elapsed)} ms`,
    segment.kind === 'text' && segment.text.trim().length > 0,
  );
  return segment;
}

service.on('stateChange', (state) => {
  switch (state.status) {
    case TranslationStatus.OFF:
      setStatus(translationStatus, 'Model not loaded', 'idle');
      translationProgressRow.hidden = true;
      setTranslationActions(false);
      break;
    case TranslationStatus.PREPARING:
      setStatus(translationStatus, 'Preparing', 'busy');
      translationDetail.textContent = 'Reading cached files and starting WASM…';
      translationProgressRow.hidden = true;
      setTranslationActions(false);
      break;
    case TranslationStatus.DOWNLOADING: {
      const progress = state.downloadProgress ?? 0;
      setStatus(translationStatus, 'Downloading model', 'busy');
      translationProgressRow.hidden = false;
      translationProgress.value = progress;
      translationProgressLabel.textContent = `${String(Math.round(progress * 100))}%`;
      setTranslationActions(false);
      break;
    }
    case TranslationStatus.READY:
      setStatus(translationStatus, 'Ready · local', 'ready');
      translationDetail.textContent =
        'Bergamot Worker and Marian WASM are ready. Translation text stays in this browser.';
      translationProgressRow.hidden = true;
      setTranslationActions(true);
      prepareTranslation.disabled = false;
      break;
    case TranslationStatus.ERROR:
      setStatus(translationStatus, 'Translation error', 'error');
      translationDetail.textContent =
        state.errorMessage ?? 'Translation failed';
      setTranslationActions(false);
      prepareTranslation.disabled = false;
      break;
    case TranslationStatus.UNSUPPORTED:
      setStatus(translationStatus, 'Unsupported browser', 'error');
      translationDetail.textContent =
        'This browser is missing Web Worker, WebAssembly, DecompressionStream, or a native Translator fallback.';
      setTranslationActions(false);
      break;
  }
});

service.on('segment', (segment) => {
  const waiter = segmentWaiters.shift();
  if (waiter !== undefined) {
    clearTimeout(waiter.timer);
    waiter.resolve(segment);
    return;
  }
  appendResult('Live browser transcript', segment.text, 'speech · live');
});

async function loadLanguages(): Promise<void> {
  if (!service.isSupported) {
    setStatus(translationStatus, 'Unsupported browser', 'error');
    translationDetail.textContent =
      'Use a current desktop Chrome, Edge, Firefox, or Safari build with WebAssembly support.';
    return;
  }

  setStatus(translationStatus, 'Checking models', 'busy');
  const languages = await service.probeLanguages();
  targetLanguage.replaceChildren();
  for (const language of languages) {
    const option = document.createElement('option');
    option.value = language.code;
    option.textContent = `${language.label}${language.requiresDownload ? ' · download' : ' · cached'}`;
    targetLanguage.append(option);
  }

  if (languages.length === 0) {
    const option = document.createElement('option');
    option.textContent = 'No released models found';
    targetLanguage.append(option);
    setStatus(translationStatus, 'Registry unavailable', 'error');
    translationDetail.textContent =
      'The Mozilla model registry could not be loaded through the local proxy.';
    return;
  }

  targetLanguage.value = languages.some((language) => language.code === 'es')
    ? 'es'
    : (languages[0]?.code ?? '');
  targetLanguage.disabled = false;
  prepareTranslation.disabled = false;
  updateAvailabilityDetail(languages);
}

function updateAvailabilityDetail(
  languages: TranslationLanguageOption[],
): void {
  const cached = languages.filter((language) => !language.requiresDownload);
  setStatus(translationStatus, 'Choose a language', 'idle');
  translationDetail.textContent = `${String(languages.length)} released targets found; ${String(cached.length)} currently cached in this browser.`;
}

prepareTranslation.addEventListener('click', () => {
  prepareTranslation.disabled = true;
  void service.enable(targetLanguage.value).finally(() => {
    prepareTranslation.disabled = false;
  });
});

targetLanguage.addEventListener('change', () => {
  service.disable();
  setTranslationActions(false);
});

translateManual.addEventListener('click', () => {
  const text = manualInput.value.trim();
  if (text === '') return;
  translateManual.disabled = true;
  void translateOne(text)
    .catch((error: unknown) => {
      appendResult(text, String(error), 'failed', false);
    })
    .finally(() => {
      translateManual.disabled = !translationReady;
    });
});

runCases.addEventListener('click', () => {
  runCases.disabled = true;
  void (async () => {
    for (const testCase of TEST_CASES) {
      try {
        await translateOne(testCase.input, testCase.name);
      } catch (error) {
        appendResult(
          testCase.input,
          String(error),
          `${testCase.name} · failed`,
          false,
        );
      }
    }
  })().finally(() => {
    runCases.disabled = !translationReady;
  });
});

simulateLive.addEventListener('click', () => {
  simulateLive.disabled = true;
  void (async () => {
    for (const caption of LIVE_CAPTION_SCRIPT) {
      service.submit(caption);
      await new Promise((resolve) => setTimeout(resolve, 350));
    }
  })().finally(() => {
    simulateLive.disabled = !translationReady;
  });
});

clearResults.addEventListener('click', () => {
  results.innerHTML = '<p class="empty">Results cleared.</p>';
  service.reset();
});

async function ensureLocalSpeechModel(
  constructor: SpeechRecognitionConstructor,
): Promise<void> {
  if (
    constructor.available === undefined ||
    constructor.install === undefined
  ) {
    throw new Error(
      'This browser exposes speech recognition but not the on-device model API. Uncheck local-only to test its default recognition service.',
    );
  }

  const options: SpeechRecognitionOptions = {
    langs: ['en-US'],
    processLocally: true,
    quality: 'dictation',
  };
  const availability = await constructor.available(options);
  if (availability === 'unavailable') {
    throw new Error('The browser has no downloadable local en-US speech model');
  }
  if (availability !== 'available') {
    setStatus(speechStatus, 'Installing local ASR model', 'busy');
    const installed = await constructor.install(options);
    if (!installed) throw new Error('The browser declined the local ASR model');
  }
}

function configureRecognition(
  constructor: SpeechRecognitionConstructor,
): BrowserSpeechRecognition {
  const recognition = new constructor();
  recognition.lang = 'en-US';
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;
  if (localSpeechOnly.checked) recognition.processLocally = true;

  recognition.onstart = () => {
    setStatus(
      speechStatus,
      localSpeechOnly.checked ? 'Listening · on-device' : 'Listening',
      'ready',
    );
    startSpeech.disabled = true;
    stopSpeech.disabled = false;
  };

  recognition.onresult = (event) => {
    let interim = '';
    for (
      let index = event.resultIndex;
      index < event.results.length;
      index += 1
    ) {
      const result = event.results[index];
      if (result === undefined) continue;
      const transcript = result[0].transcript.trim();
      if (result.isFinal) {
        speechFinal.textContent =
          speechFinal.textContent === '—'
            ? transcript
            : `${speechFinal.textContent} ${transcript}`;
        service.submit(transcript);
      } else {
        interim += `${transcript} `;
      }
    }
    speechInterim.textContent = interim.trim() || '—';
  };

  recognition.onerror = (event) => {
    setStatus(speechStatus, `ASR error · ${event.error}`, 'error');
    if (event.message !== undefined) speechInterim.textContent = event.message;
  };

  recognition.onend = () => {
    activeRecognition = null;
    stopSpeech.disabled = true;
    startSpeech.disabled = !translationReady;
    setStatus(speechStatus, 'Stopped', 'idle');
  };

  return recognition;
}

startSpeech.addEventListener('click', () => {
  const constructor = getSpeechConstructor();
  if (constructor === null) {
    setStatus(speechStatus, 'SpeechRecognition unsupported', 'error');
    return;
  }

  startSpeech.disabled = true;
  setStatus(speechStatus, 'Preparing speech model', 'busy');
  void (async () => {
    if (localSpeechOnly.checked) await ensureLocalSpeechModel(constructor);
    const recognition = configureRecognition(constructor);
    activeRecognition = recognition;
    recognition.start();
  })().catch((error: unknown) => {
    activeRecognition = null;
    setStatus(speechStatus, 'Could not start ASR', 'error');
    speechInterim.textContent = String(error);
    startSpeech.disabled = !translationReady;
  });
});

stopSpeech.addEventListener('click', () => {
  activeRecognition?.stop();
});

window.addEventListener('beforeunload', () => {
  activeRecognition?.abort();
  service.destroy();
  for (const waiter of segmentWaiters) {
    clearTimeout(waiter.timer);
    waiter.reject(new Error('Page closed'));
  }
});

if (getSpeechConstructor() === null) {
  setStatus(speechStatus, 'SpeechRecognition unsupported', 'error');
  startSpeech.disabled = true;
} else {
  setStatus(speechStatus, 'Browser speech API detected', 'idle');
}

void loadLanguages().catch((error: unknown) => {
  setStatus(translationStatus, 'Setup failed', 'error');
  translationDetail.textContent = String(error);
});
