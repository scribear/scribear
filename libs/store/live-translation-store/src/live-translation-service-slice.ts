import { type PayloadAction, createSlice } from '@reduxjs/toolkit';

import { DEFAULT_TARGET_LANGUAGE } from './config/translation-languages.js';
import {
  type TranslatedSegment,
  type TranslationLanguageOption,
  type TranslationSample,
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
 * Sliding-window size for the translation latency averages. Matches the
 * transcription latency window, so a reader comparing the two overlays is
 * comparing figures smoothed over the same number of samples.
 */
const LATENCY_WINDOW_SIZE = 60;

/** A rolling latency figure: the newest sample and the windowed mean. */
export interface TranslationLatencyWindow {
  samples: number[];
  last: number;
  average: number;
}

/**
 * Rolling translation timings. `wait` is queue time, `translate` is the model
 * call, `total` is their sum - how stale a caption was when its translation
 * reached the screen.
 */
export interface TranslationLatencyState {
  wait: TranslationLatencyWindow;
  translate: TranslationLatencyWindow;
  total: TranslationLatencyWindow;
  /** Captions still queued when the last sample was taken. */
  queuedCaptions: number;
  /** How many `translate()` calls have been measured. */
  sampleCount: number;
}

function emptyWindow(): TranslationLatencyWindow {
  return { samples: [], last: 0, average: 0 };
}

function emptyLatency(): TranslationLatencyState {
  return {
    wait: emptyWindow(),
    translate: emptyWindow(),
    total: emptyWindow(),
    queuedCaptions: 0,
    sampleCount: 0,
  };
}

function pushSample(window: TranslationLatencyWindow, value: number): void {
  window.samples.push(value);
  if (window.samples.length > LATENCY_WINDOW_SIZE) {
    window.samples.shift();
  }
  window.last = value;
  window.average =
    window.samples.reduce((sum, sample) => sum + sample, 0) /
    window.samples.length;
}

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
  droppedCaptions: number;
  segments: TranslatedSegment[];
  availableLanguages: TranslationLanguageOption[];
  latency: TranslationLatencyState;
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
  droppedCaptions: 0,
  segments: [],
  availableLanguages: [],
  latency: emptyLatency(),
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
 * Selects the rolling time captions spend queued before their `translate()`
 * call starts. Grows when the model cannot keep pace with the room.
 * @param state - Redux state containing the liveTranslationService slice.
 */
export const selectTranslationWaitLatency = (
  state: WithLiveTranslationService,
) => state.liveTranslationService.latency.wait;

/**
 * Selects the rolling duration of the `translate()` call itself.
 * @param state - Redux state containing the liveTranslationService slice.
 */
export const selectTranslationCallLatency = (
  state: WithLiveTranslationService,
) => state.liveTranslationService.latency.translate;

/**
 * Selects the rolling total (queue wait plus call) - how stale a caption was
 * when its translation reached the screen.
 * @param state - Redux state containing the liveTranslationService slice.
 */
export const selectTranslationTotalLatency = (
  state: WithLiveTranslationService,
) => state.liveTranslationService.latency.total;

/**
 * Selects the caption backlog measured when the last translation finished.
 * @param state - Redux state containing the liveTranslationService slice.
 */
export const selectTranslationQueuedCaptions = (
  state: WithLiveTranslationService,
) => state.liveTranslationService.latency.queuedCaptions;

/**
 * Selects how many `translate()` calls have been measured this session.
 * @param state - Redux state containing the liveTranslationService slice.
 */
export const selectTranslationSampleCount = (
  state: WithLiveTranslationService,
) => state.liveTranslationService.latency.sampleCount;

/**
 * Selects how many captions have been dropped to keep up, or lost to a failed
 * translation. The gap markers on screen coalesce; this does not.
 * @param state - Redux state containing the liveTranslationService slice.
 */
export const selectTranslationDroppedCaptions = (
  state: WithLiveTranslationService,
) => state.liveTranslationService.droppedCaptions;

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
      state.droppedCaptions = action.payload.droppedCaptions;
    },
    /**
     * Records the timing of one completed translation into the rolling
     * windows behind the metrics overlay.
     */
    recordTranslationSample: (
      state,
      action: PayloadAction<TranslationSample>,
    ) => {
      const { waitMs, translateMs, queuedCaptions } = action.payload;
      pushSample(state.latency.wait, waitMs);
      pushSample(state.latency.translate, translateMs);
      pushSample(state.latency.total, waitMs + translateMs);
      state.latency.queuedCaptions = queuedCaptions;
      state.latency.sampleCount += 1;
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
      state.droppedCaptions = 0;
      // A new session's throughput says nothing about the last one's.
      state.latency = emptyLatency();
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
  recordTranslationSample,
} = liveTranslationServiceSlice.actions;
