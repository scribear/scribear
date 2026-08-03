import { configureStore } from '@reduxjs/toolkit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { appInitialization } from '@scribear/redux-remember-store';
import {
  handleTranscript,
  transcriptionContentReducer,
} from '@scribear/transcription-content-store';

import {
  SummarizationService,
  SummarizationStatus,
} from '#src/summarization-service.js';
import { createTranscriptExportMiddleware } from '#src/transcript-export-middleware.js';
import {
  downloadLastSummary,
  downloadTranscript,
  requestSummary,
  selectExportErrorMessage,
  selectIsSummarizationOffered,
  selectLastSummary,
  transcriptExportReducer,
} from '#src/transcript-export-slice.js';

import {
  type FakeSummarizerApi,
  installFakeSummarizerApi,
} from './fake-summarizer-api.js';

/** The feature ships off; these tests opt in. See `config/feature-flags.ts`. */
const ENABLED = { enabled: true };

/** Captures what the page handed the browser to download. */
interface SavedFile {
  fileName: string;
  text: string;
}

function captureDownloads(): SavedFile[] {
  const saved: SavedFile[] = [];
  // jsdom has no Blob->text bridge and no real downloads, so intercept at the
  // anchor: this is exactly the surface `downloadTextFile` uses.
  const realCreate = document.createElement.bind(document);
  vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
    const element = realCreate(tag);
    if (tag === 'a') {
      const anchor = element as HTMLAnchorElement;
      anchor.click = () => {
        saved.push({ fileName: anchor.download, text: lastBlobText });
      };
    }
    return element;
  });

  let lastBlobText = '';
  const RealBlob = globalThis.Blob;
  vi.stubGlobal(
    'Blob',
    class extends RealBlob {
      constructor(parts: BlobPart[], options?: BlobPropertyBag) {
        super(parts, options);
        lastBlobText = parts.map((part) => String(part)).join('');
      }
    },
  );
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: () => 'blob:fake',
    revokeObjectURL: () => undefined,
  });

  return saved;
}

function createTestStore(service: SummarizationService) {
  return configureStore({
    reducer: {
      transcriptionContent: transcriptionContentReducer,
      transcriptExport: transcriptExportReducer,
    },
    middleware: (getDefaultMiddleware) =>
      getDefaultMiddleware().concat(createTranscriptExportMiddleware(service)),
  });
}

describe('createTranscriptExportMiddleware', () => {
  let fake: FakeSummarizerApi;
  let service: SummarizationService;
  let store: ReturnType<typeof createTestStore>;
  let saved: SavedFile[];

  beforeEach(() => {
    saved = captureDownloads();
    fake = installFakeSummarizerApi();
    service = new SummarizationService(ENABLED);
    store = createTestStore(service);
  });

  afterEach(() => {
    service.destroy();
    fake.uninstall();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  /** Feeds finalized transcript text through the real content reducer. */
  const speak = (text: string) => {
    store.dispatch(
      handleTranscript({ final: { text: [text] }, inProgress: null }),
    );
  };

  describe('downloading the transcript', () => {
    it('saves it as transcript-YYYYMMDD-HHMMSS.txt', () => {
      speak('Good morning everyone.');

      store.dispatch(downloadTranscript());

      expect(saved).toHaveLength(1);
      expect(saved[0]?.fileName).toMatch(/^transcript-\d{8}-\d{6}\.txt$/);
      expect(saved[0]?.text).toContain('Good morning everyone.');
    });

    it('saves what was actually said, with no header wrapped around it', () => {
      speak('First line.');

      store.dispatch(downloadTranscript());

      expect(saved[0]?.text).toBe('First line.\n');
    });

    it('reports a save the browser refused', () => {
      vi.spyOn(document, 'createElement').mockImplementation(() => {
        throw new Error('blocked');
      });
      speak('Something.');

      store.dispatch(downloadTranscript());

      expect(selectExportErrorMessage(store.getState())).toMatch(
        /would not save/i,
      );
    });
  });

  describe('offering summarization', () => {
    it('offers it when the browser says the model can run here', async () => {
      store.dispatch(appInitialization());

      await vi.waitFor(() => {
        expect(selectIsSummarizationOffered(store.getState())).toBe(true);
      });
    });

    it('withholds it when the browser says the model cannot run here', async () => {
      fake.configure({ availability: 'unavailable' });
      store.dispatch(appInitialization());

      await vi.waitFor(() => {
        expect(selectIsSummarizationOffered(store.getState())).toBe(false);
      });
    });

    it('withholds it entirely when the API is absent', () => {
      service.destroy();
      fake.uninstall();
      service = new SummarizationService(ENABLED);
      store = createTestStore(service);

      store.dispatch(appInitialization());

      expect(selectIsSummarizationOffered(store.getState())).toBe(false);
    });
  });

  describe('downloading a summary', () => {
    it('saves it as summary-YYYYMMDD-HHMMSS.txt', async () => {
      speak('The scheduler decides which process runs next.');

      store.dispatch(requestSummary());

      await vi.waitFor(() => {
        expect(saved).toHaveLength(1);
      });
      expect(saved[0]?.fileName).toMatch(/^summary-\d{8}-\d{6}\.txt$/);
    });

    it('states in the file that it was generated locally', async () => {
      speak('The scheduler decides which process runs next.');

      store.dispatch(requestSummary());

      await vi.waitFor(() => {
        expect(saved).toHaveLength(1);
      });
      expect(saved[0]?.text).toContain('GENERATED LOCALLY, IN YOUR BROWSER.');
    });

    it('keeps the summary so it can be saved again', async () => {
      // The automatic save happens after the run, when the page no longer has
      // user activation and a browser may refuse the download. This is what
      // makes a fresh click able to fix that.
      speak('The scheduler decides which process runs next.');
      store.dispatch(requestSummary());
      await vi.waitFor(() => {
        expect(selectLastSummary(store.getState())).not.toBeNull();
      });

      store.dispatch(downloadLastSummary());

      expect(saved).toHaveLength(2);
      expect(saved[0]?.fileName).toBe(saved[1]?.fileName);
    });

    it('saves nothing when summarization fails', async () => {
      fake.configure({ summarizeFailsWith: 'UnknownError' });
      speak('The scheduler decides which process runs next.');

      store.dispatch(requestSummary());

      await vi.waitFor(() => {
        expect(store.getState().transcriptExport.summarizationStatus).toBe(
          SummarizationStatus.ERROR,
        );
      });
      expect(saved).toEqual([]);
      expect(selectExportErrorMessage(store.getState())).not.toBeNull();
    });

    it('reports an empty transcript instead of saving an empty summary', async () => {
      store.dispatch(requestSummary());

      await vi.waitFor(() => {
        expect(selectExportErrorMessage(store.getState())).toMatch(
          /no transcript/i,
        );
      });
      expect(saved).toEqual([]);
    });
  });
});
