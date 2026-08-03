/**
 * Test harness page for `tools/transcript-export-e2e`.
 *
 * Bundles the real export code and runs it against real Chrome over
 * `http://localhost`, so the download path exercises a real `Blob`, a real
 * object URL and a real browser download, and the summarizer path exercises
 * the real Gemini Nano API where the device can host it.
 */
import {
  type SummarizationResult,
  SummarizationService,
  type SummarizationServiceState,
  buildSummaryFile,
  buildTranscriptFile,
  downloadTextFile,
  getSummarizerApi,
  summaryFileName,
  transcriptFileName,
} from '@scribear/transcript-export-store';

declare global {
  interface Window {
    __harness: Harness;
  }
}

interface Harness {
  service: SummarizationService;
  state: SummarizationServiceState;
  /** Anything thrown at the page: an empty list is itself an assertion. */
  pageErrors: string[];
  /** Transcript the harness will export. */
  transcript: string;
  setTranscript: (text: string) => void;
  isApiPresent: () => boolean;
  checkAvailability: () => Promise<string>;
  saveTranscript: () => { fileName: string; saved: boolean };
  /** Runs a real summary and saves it. Null when it failed or was refused. */
  summarizeAndSave: () => Promise<SummarizeAndSaveResult | null>;
  cancel: () => void;
  /** Result of the click-driven run, read by the e2e script. */
  lastRun: SummarizeAndSaveResult | null;
  /** Set once the click-driven run has settled. */
  done: boolean;
}

/** What a completed summary run hands back. */
interface SummarizeAndSaveResult {
  fileName: string;
  saved: boolean;
  result: SummarizationResult;
  fileText: string;
}

/**
 * With `?stub=1`, installs a stand-in `Summarizer` before the service reads
 * the global.
 *
 * This is **not** a test of Gemini Nano - it is how the recursive reduction,
 * the file builder and the real browser download get exercised on machines
 * that cannot host the model, which is most of them. Everything around the
 * model is real: real timers, real AbortController, real Blob, real download.
 * The stub enforces Chrome's real 9216-token quota using the token cost
 * measured from the real API, so a chunk size that would be rejected in
 * production is rejected here too.
 */
function installStubSummarizer(): void {
  const measuredTokens = (chars: number) => Math.round(560 + 0.209 * chars);
  (globalThis as { Summarizer?: unknown }).Summarizer = {
    availability: () => Promise.resolve('available'),
    create: () =>
      Promise.resolve({
        inputQuota: 9216,
        destroy: () => undefined,
        measureInputUsage: (input: string) =>
          Promise.resolve(measuredTokens(input.length)),
        summarize: (input: string) => {
          if (measuredTokens(input.length) > 9216) {
            const error = new Error('The input is too large.');
            error.name = 'QuotaExceededError';
            return Promise.reject(error);
          }
          const words = input.trim().split(/\s+/);
          const kept = words.slice(0, Math.max(4, Math.ceil(words.length / 5)));
          return Promise.resolve(`- ${kept.join(' ')}`);
        },
      }),
  };
}

if (new URLSearchParams(location.search).get('stub') === '1') {
  installStubSummarizer();
}

// Force-enabled: the feature ships switched off (see `config/feature-flags.ts`),
// and this tool's job is to keep the machinery behind the switch working so
// turning it on later is a one-line change rather than an excavation. The
// switched-off behaviour is covered by unit tests, not here.
const service = new SummarizationService({ enabled: true });

const harness: Harness = {
  service,
  state: service.state,
  pageErrors: [],
  transcript: '',
  setTranscript: (text) => {
    harness.transcript = text;
  },
  isApiPresent: () => getSummarizerApi() !== null,
  checkAvailability: () => service.checkAvailability(),
  saveTranscript: () => {
    const fileName = transcriptFileName(new Date());
    const saved = downloadTextFile(
      fileName,
      buildTranscriptFile(harness.transcript),
    );
    return { fileName, saved };
  },
  summarizeAndSave: async () => {
    const result = await service.summarize(harness.transcript);
    if (!result) return null;
    const generatedAt = new Date();
    const fileName = summaryFileName(generatedAt);
    const fileText = buildSummaryFile(result, generatedAt);
    const saved = downloadTextFile(fileName, fileText);
    return { fileName, saved, result, fileText };
  },
  cancel: () => {
    service.cancel();
  },
  lastRun: null,
  done: false,
};
window.__harness = harness;

service.on('stateChange', (state) => {
  harness.state = state;
});

window.addEventListener('error', (event) => {
  harness.pageErrors.push(`error: ${event.message}`);
});
window.addEventListener('unhandledrejection', (event) => {
  harness.pageErrors.push(`unhandledrejection: ${String(event.reason)}`);
});

// Both buttons exist so the actions that may need user activation - the model
// download, and the download of the saved file - are driven by a real click.
document.getElementById('save-transcript')?.addEventListener('click', () => {
  window.__harness.saveTranscript();
});
document.getElementById('summarize')?.addEventListener('click', () => {
  void (async () => {
    window.__harness.lastRun = await harness.summarizeAndSave();
    window.__harness.done = true;
  })();
});

document.getElementById('ready')?.setAttribute('data-ready', 'true');
