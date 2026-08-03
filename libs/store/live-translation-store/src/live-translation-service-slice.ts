import { type PayloadAction, createSlice } from '@reduxjs/toolkit';

import { DEFAULT_TARGET_LANGUAGE } from './config/translation-languages.js';
import {
  type TranslatedSegment,
  type TranslationLanguageOption,
  type TranslationServiceState,
  TranslationStatus,
} from './translation-service.js';

/**
 * How many translated segments are retained for display. Well above what fits
 * on screen so a reader can scroll back, but bounded - a lecture-length
 * session would otherwise grow this array without limit.
 */
const MAX_RETAINED_SEGMENTS = 500;

/**
 * Mirror of the {@link TranslationService}'s runtime state, plus the translated
 * caption history the display renders.
 *
 * Never persisted: model availability and translator liveness are properties
 * of this browser right now.
 */
export interface LiveTranslationServiceSlice {
  status: TranslationStatus;
  targetLanguage: string;
  downloadProgress: number | null;
  errorMessage: string | null;
  hasDroppedContent: boolean;
  segments: TranslatedSegment[];
  availableLanguages: TranslationLanguageOption[];
}

interface WithLiveTranslationService {
  liveTranslationService: LiveTranslationServiceSlice;
}

const initialState: LiveTranslationServiceSlice = {
  // Assume unsupported until the service reports otherwise, so nothing renders
  // on a browser without the API even for one frame.
  status: TranslationStatus.UNSUPPORTED,
  targetLanguage: DEFAULT_TARGET_LANGUAGE,
  downloadProgress: null,
  errorMessage: null,
  hasDroppedContent: false,
  segments: [],
  availableLanguages: [],
};

/**
 * Selects the current translation status.
 * @param state - Redux state containing the liveTranslationService slice.
 */
export const selectTranslationStatus = (state: WithLiveTranslationService) =>
  state.liveTranslationService.status;

/**
 * Selects whether this browser can translate at all. Every piece of
 * translation UI is hidden when this is false.
 * @param state - Redux state containing the liveTranslationService slice.
 */
export const selectIsTranslationSupported = (
  state: WithLiveTranslationService,
) => state.liveTranslationService.status !== TranslationStatus.UNSUPPORTED;

/**
 * Selects whether a language model download is currently in progress.
 * @param state - Redux state containing the liveTranslationService slice.
 */
export const selectIsTranslationDownloading = (
  state: WithLiveTranslationService,
) => state.liveTranslationService.status === TranslationStatus.DOWNLOADING;

/**
 * Selects whether translated captions are being produced or attempted, i.e.
 * whether the translated caption panel should be on screen.
 * @param state - Redux state containing the liveTranslationService slice.
 */
export const selectIsTranslationRunning = (state: WithLiveTranslationService) =>
  state.liveTranslationService.status !== TranslationStatus.UNSUPPORTED &&
  state.liveTranslationService.status !== TranslationStatus.OFF;

/**
 * Selects the translated caption segments to display, oldest first.
 * @param state - Redux state containing the liveTranslationService slice.
 */
export const selectTranslatedSegments = (state: WithLiveTranslationService) =>
  state.liveTranslationService.segments;

/**
 * Selects the user-visible translation error, or null when healthy.
 * @param state - Redux state containing the liveTranslationService slice.
 */
export const selectTranslationErrorMessage = (
  state: WithLiveTranslationService,
) => state.liveTranslationService.errorMessage;

/**
 * Selects download progress in the range 0..1, or null when not downloading.
 * @param state - Redux state containing the liveTranslationService slice.
 */
export const selectTranslationDownloadProgress = (
  state: WithLiveTranslationService,
) => state.liveTranslationService.downloadProgress;

/**
 * Selects the target languages this browser reported as usable.
 * @param state - Redux state containing the liveTranslationService slice.
 */
export const selectAvailableTranslationLanguages = (
  state: WithLiveTranslationService,
) => state.liveTranslationService.availableLanguages;

/**
 * Selects the language the service is currently translating into.
 * @param state - Redux state containing the liveTranslationService slice.
 */
export const selectActiveTargetLanguage = (state: WithLiveTranslationService) =>
  state.liveTranslationService.targetLanguage;

/**
 * Redux slice mirroring the {@link TranslationService} into the store. Written
 * exclusively by the live-translation middleware.
 */
export const liveTranslationServiceSlice = createSlice({
  name: 'liveTranslationService',
  initialState,
  reducers: {
    /**
     * Applies a service state snapshot. Segments are untouched - they arrive
     * through `appendTranslatedSegment`.
     */
    setTranslationServiceState: (
      state,
      action: PayloadAction<TranslationServiceState>,
    ) => {
      state.status = action.payload.status;
      state.targetLanguage = action.payload.targetLanguage;
      state.downloadProgress = action.payload.downloadProgress;
      state.errorMessage = action.payload.errorMessage;
      state.hasDroppedContent = action.payload.hasDroppedContent;
    },
    /**
     * Appends one translated segment (or gap marker), trimming the oldest
     * once the retention limit is passed.
     */
    appendTranslatedSegment: (
      state,
      action: PayloadAction<TranslatedSegment>,
    ) => {
      state.segments.push(action.payload);
      if (state.segments.length > MAX_RETAINED_SEGMENTS) {
        state.segments.splice(0, state.segments.length - MAX_RETAINED_SEGMENTS);
      }
    },
    /**
     * Replaces the list of selectable target languages after a probe.
     */
    setAvailableTranslationLanguages: (
      state,
      action: PayloadAction<TranslationLanguageOption[]>,
    ) => {
      state.availableLanguages = action.payload;
    },
    /**
     * Clears displayed translations, e.g. when a new session starts.
     */
    clearTranslatedSegments: (state) => {
      state.segments = [];
      state.hasDroppedContent = false;
    },
  },
});

// Reducer for the liveTranslationService slice.
export const liveTranslationServiceReducer =
  liveTranslationServiceSlice.reducer;

export const {
  setTranslationServiceState,
  appendTranslatedSegment,
  setAvailableTranslationLanguages,
  clearTranslatedSegments,
} = liveTranslationServiceSlice.actions;
