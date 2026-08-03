import { type Middleware } from '@reduxjs/toolkit';

import {
  appInitialization,
  rememberRehydrated,
} from '@scribear/redux-remember-store';
import {
  type TranscriptionContentSlice,
  appendFinalizedTranscription,
  clearTranscription,
  commitInProgressTranscription,
  handleTranscript,
} from '@scribear/transcription-content-store';

import {
  type LiveTranslationPreferencesSlice,
  disableTranslation,
  enableTranslation,
  setTargetLanguage,
} from './live-translation-preferences-slice.js';
import {
  type LiveTranslationServiceSlice,
  appendTranslatedSegment,
  clearTranslatedSegments,
  setAvailableTranslationLanguages,
  setTranslationServiceState,
} from './live-translation-service-slice.js';
import { type TranslationService } from './translation-service.js';

/**
 * Minimal Redux state shape required by the live translation middleware.
 */
interface WithLiveTranslationState {
  liveTranslationPreferences: LiveTranslationPreferencesSlice;
  liveTranslationService: LiveTranslationServiceSlice;
  transcriptionContent: TranscriptionContentSlice;
}

/**
 * Bridges a {@link TranslationService} to the Redux store.
 *
 * Two things about this middleware are load-bearing:
 *
 * 1. **`enable()` is called synchronously inside the dispatch.** Chromium
 *    demands user activation for a `create()` that downloads a model. Redux
 *    dispatch is synchronous, so an `enableTranslation` dispatched from a
 *    click handler still carries that activation; deferring it to a thunk or
 *    a `useEffect` does not.
 * 2. **Restoring the preference does not restore the download.** A persisted
 *    "on" auto-enables only when the model is already `available` on this
 *    device. Otherwise translation stays off and the user is asked again -
 *    which is what stops a stored preference from silently spending someone's
 *    metered connection on page load.
 *
 * @param service - The translation service instance to drive.
 */
export const createLiveTranslationMiddleware =
  (service: TranslationService): Middleware<object, WithLiveTranslationState> =>
  (store) => {
    service.on('stateChange', (state) => {
      store.dispatch(setTranslationServiceState(state));
    });
    service.on('segment', (segment) => {
      store.dispatch(appendTranslatedSegment(segment));
    });
    service.on('cleared', () => {
      store.dispatch(clearTranslatedSegments());
    });

    /** Re-probes selectable languages; failures leave the picker as it was. */
    const refreshLanguages = () => {
      service
        .probeLanguages()
        .then((languages) => {
          store.dispatch(setAvailableTranslationLanguages(languages));
        })
        .catch(() => {
          // probeLanguages() already absorbs per-language failures. This is
          // the belt-and-braces path, so an unexpected rejection can never
          // surface as an unhandled rejection in a caption view.
        });
    };

    return (next) => (action) => {
      // Read before reducing: `commitInProgressTranscription` carries no
      // payload, and by the time the reducer has run the text it promoted is
      // no longer in `inProgressTranscription`.
      const pendingInterim = commitInProgressTranscription.match(action)
        ? (store
            .getState()
            .transcriptionContent.inProgressTranscription?.text.join('') ??
          null)
        : null;

      const result = next(action);

      if (appInitialization.match(action)) {
        store.dispatch(setTranslationServiceState(service.state));
        if (service.isSupported) refreshLanguages();
      }

      if (rememberRehydrated.match(action)) {
        const { isTranslationEnabled, targetLanguage } =
          store.getState().liveTranslationPreferences;
        if (isTranslationEnabled && service.isSupported) {
          void service
            .checkAvailability(targetLanguage)
            .then((availability) => {
              if (availability === 'available') {
                void service.enable(targetLanguage);
              } else {
                // Needs a download, or is gone entirely. Fall back to off so
                // the user is asked rather than surprised.
                store.dispatch(disableTranslation());
              }
            });
        }
      }

      if (enableTranslation.match(action)) {
        const { targetLanguage } = store.getState().liveTranslationPreferences;
        void service.enable(targetLanguage);
      }

      if (disableTranslation.match(action)) {
        service.disable();
      }

      if (setTargetLanguage.match(action)) {
        const { isTranslationEnabled, targetLanguage } =
          store.getState().liveTranslationPreferences;
        // Switching language mid-session restarts the translator. Text already
        // on screen stays: it is still a true record of what was said, in the
        // language it was produced in.
        if (isTranslationEnabled) void service.enable(targetLanguage);
      }

      // Only finalized transcripts are translated. Interim text is rewritten
      // several times a second, so translating it would spend the model's
      // whole throughput on output that is about to be replaced.
      if (appendFinalizedTranscription.match(action)) {
        service.submit(action.payload.text.join(''));
      }

      if (handleTranscript.match(action) && action.payload.final) {
        service.submit(action.payload.final.text.join(''));
      }

      if (pendingInterim !== null) {
        service.submit(pendingInterim);
      }

      if (clearTranscription.match(action)) {
        service.reset();
      }

      return result;
    };
  };
