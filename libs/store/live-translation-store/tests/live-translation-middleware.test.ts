import { configureStore } from '@reduxjs/toolkit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  appInitialization,
  rememberRehydrated,
} from '@scribear/redux-remember-store';
import {
  appendFinalizedTranscription,
  clearTranscription,
  commitInProgressTranscription,
  handleTranscript,
  replaceInProgressTranscription,
  transcriptionContentReducer,
} from '@scribear/transcription-content-store';

import { createLiveTranslationMiddleware } from '#src/live-translation-middleware.js';
import {
  disableTranslation,
  enableTranslation,
  liveTranslationPreferencesReducer,
  setTargetLanguage,
} from '#src/live-translation-preferences-slice.js';
import {
  liveTranslationServiceReducer,
  selectTranslatedSegments,
  selectTranslationCallLatency,
  selectTranslationQueuedCaptions,
  selectTranslationSampleCount,
  selectTranslationStatus,
  selectTranslationTotalLatency,
  selectTranslationWaitLatency,
} from '#src/live-translation-service-slice.js';
import {
  TranslationService,
  TranslationStatus,
} from '#src/translation-service.js';

import {
  type FakeTranslatorApi,
  installFakeTranslatorApi,
} from './fake-translator-api.js';

function createTestStore(service: TranslationService) {
  return configureStore({
    reducer: {
      transcriptionContent: transcriptionContentReducer,
      liveTranslationPreferences: liveTranslationPreferencesReducer,
      liveTranslationService: liveTranslationServiceReducer,
    },
    middleware: (getDefaultMiddleware) =>
      getDefaultMiddleware().concat(createLiveTranslationMiddleware(service)),
  });
}

describe('createLiveTranslationMiddleware', () => {
  let fake: FakeTranslatorApi;
  let service: TranslationService;
  let store: ReturnType<typeof createTestStore>;

  beforeEach(() => {
    fake = installFakeTranslatorApi({ availability: { es: 'available' } });
    service = new TranslationService();
    store = createTestStore(service);
  });

  afterEach(() => {
    service.destroy();
    fake.uninstall();
  });

  it('mirrors the service state into the store on app initialization', () => {
    store.dispatch(appInitialization());

    expect(selectTranslationStatus(store.getState())).toBe(
      TranslationStatus.OFF,
    );
  });

  describe('with translation enabled', () => {
    beforeEach(async () => {
      store.dispatch(enableTranslation('es'));
      // enable() is kicked off synchronously inside the dispatch, but its
      // create() still resolves on a microtask.
      await vi.waitFor(() => {
        expect(selectTranslationStatus(store.getState())).toBe(
          TranslationStatus.READY,
        );
      });
    });

    it('translates finalized transcripts', async () => {
      store.dispatch(
        handleTranscript({
          final: { text: ['Hello ', 'there'] },
          inProgress: null,
        }),
      );

      await vi.waitFor(() => {
        expect(selectTranslatedSegments(store.getState())).toHaveLength(1);
      });
      expect(fake.translateCalls).toEqual(['Hello there']);
    });

    it('records a latency sample for each completed translation', async () => {
      store.dispatch(
        handleTranscript({
          final: { text: ['Hello ', 'there'] },
          inProgress: null,
        }),
      );

      await vi.waitFor(() => {
        expect(selectTranslationSampleCount(store.getState())).toBe(1);
      });
      const total = selectTranslationTotalLatency(store.getState());
      expect(total.last).toBe(
        selectTranslationWaitLatency(store.getState()).last +
          selectTranslationCallLatency(store.getState()).last,
      );
      expect(total.average).toBe(total.last);
      expect(selectTranslationQueuedCaptions(store.getState())).toBe(0);
    });

    it('drops the latency history when a new session clears the captions', async () => {
      store.dispatch(
        handleTranscript({
          final: { text: ['Hello'] },
          inProgress: null,
        }),
      );
      await vi.waitFor(() => {
        expect(selectTranslationSampleCount(store.getState())).toBe(1);
      });

      store.dispatch(clearTranscription());

      await vi.waitFor(() => {
        expect(selectTranslationSampleCount(store.getState())).toBe(0);
      });
      expect(selectTranslationTotalLatency(store.getState()).average).toBe(0);
    });

    it('never translates in-progress transcripts', async () => {
      // Interim results are rewritten several times a second. Translating them
      // would burn the model's throughput on text about to be replaced - and
      // would put half-finished sentences in front of the reader.
      store.dispatch(
        handleTranscript({
          final: null,
          inProgress: { text: ['Hel'] },
        }),
      );
      store.dispatch(replaceInProgressTranscription({ text: ['Hello th'] }));
      store.dispatch(replaceInProgressTranscription({ text: ['Hello there'] }));

      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(fake.translateCalls).toEqual([]);
    });

    it('translates interim text once it is committed as final', async () => {
      store.dispatch(replaceInProgressTranscription({ text: ['Hello there'] }));
      store.dispatch(commitInProgressTranscription());

      await vi.waitFor(() => {
        expect(fake.translateCalls).toEqual(['Hello there']);
      });
    });

    it('translates directly appended finalized sequences', async () => {
      store.dispatch(appendFinalizedTranscription({ text: ['Good ', 'day'] }));

      await vi.waitFor(() => {
        expect(fake.translateCalls).toEqual(['Good day']);
      });
    });

    it('clears translated captions when the transcript is cleared', async () => {
      store.dispatch(appendFinalizedTranscription({ text: ['Hello'] }));
      await vi.waitFor(() => {
        expect(selectTranslatedSegments(store.getState())).toHaveLength(1);
      });

      store.dispatch(clearTranscription());

      expect(selectTranslatedSegments(store.getState())).toEqual([]);
    });

    it('restarts the translator when the target language changes', async () => {
      store.dispatch(setTargetLanguage('fr'));

      await vi.waitFor(() => {
        expect(fake.createCalls.at(-1)?.targetLanguage).toBe('fr');
      });
      expect(fake.liveTranslators).toBe(1);
    });

    it('stops translating when the user turns translation off', async () => {
      store.dispatch(disableTranslation());
      store.dispatch(appendFinalizedTranscription({ text: ['Hello'] }));

      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(fake.translateCalls).toEqual([]);
      expect(selectTranslationStatus(store.getState())).toBe(
        TranslationStatus.OFF,
      );
    });
  });

  describe('restoring a persisted preference', () => {
    it('resumes translation when the model is already on the device', async () => {
      store.dispatch(enableTranslation('es'));
      store.dispatch(disableTranslation());
      store.dispatch(enableTranslation('es'));
      store.dispatch(rememberRehydrated());

      await vi.waitFor(() => {
        expect(selectTranslationStatus(store.getState())).toBe(
          TranslationStatus.READY,
        );
      });
    });

    it('turns itself off rather than start a download the user did not ask for', async () => {
      fake.configure({ availability: { es: 'downloadable' } });
      store.dispatch(enableTranslation('es'));
      // Undo the eager enable so only the rehydrate path is under test.
      service.disable();
      store.dispatch(rememberRehydrated());

      await vi.waitFor(() => {
        expect(
          store.getState().liveTranslationPreferences.isTranslationEnabled,
        ).toBe(false);
      });
      expect(selectTranslationStatus(store.getState())).toBe(
        TranslationStatus.OFF,
      );
    });
  });

  describe('on a browser without the Translator API', () => {
    beforeEach(() => {
      service.destroy();
      fake.uninstall();
      service = new TranslationService();
      store = createTestStore(service);
    });

    it('leaves the store reporting unsupported and swallows transcripts', async () => {
      store.dispatch(appInitialization());
      store.dispatch(appendFinalizedTranscription({ text: ['Hello'] }));

      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(selectTranslationStatus(store.getState())).toBe(
        TranslationStatus.UNSUPPORTED,
      );
      expect(selectTranslatedSegments(store.getState())).toEqual([]);
    });
  });
});
