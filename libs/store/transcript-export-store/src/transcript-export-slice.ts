import { type PayloadAction, createSlice } from '@reduxjs/toolkit';

import {
  type SummarizationProgress,
  type SummarizationServiceState,
  SummarizationStatus,
} from './summarization-service.js';
import type { SummarizerAvailability } from './summarizer-api.js';

/**
 * State for transcript and summary export.
 *
 * Never persisted. Whether the foundation model is on this device, and whether
 * a summary has been produced, are facts about this browser right now.
 */
export interface TranscriptExportSlice {
  summarizationStatus: SummarizationStatus;
  summarizerAvailability: SummarizerAvailability | null;
  downloadProgress: number | null;
  progress: SummarizationProgress | null;
  summarizationError: string | null;
  hasCompletedRun: boolean;
  /** The last summary produced, kept so it can be saved again. */
  lastSummary: { fileName: string; text: string } | null;
  /** A file that could not be saved (blocked download, no Blob support). */
  saveError: string | null;
}

interface WithTranscriptExport {
  transcriptExport: TranscriptExportSlice;
}

const initialState: TranscriptExportSlice = {
  // Assume unsupported until the service reports otherwise, so the summary
  // option never flashes on a device that cannot run the model.
  summarizationStatus: SummarizationStatus.UNSUPPORTED,
  summarizerAvailability: null,
  downloadProgress: null,
  progress: null,
  summarizationError: null,
  hasCompletedRun: false,
  lastSummary: null,
  saveError: null,
};

/**
 * Selects whether the summary option should be offered at all.
 *
 * True only when the browser has the API *and* reported that the model can
 * actually run here. The API object exists on machines whose hardware is below
 * the Gemini Nano bar, where every attempt fails with "the service is not
 * running" - offering a button there is worse than offering nothing.
 * @param state - Redux state containing the transcriptExport slice.
 */
export const selectIsSummarizationOffered = (state: WithTranscriptExport) =>
  state.transcriptExport.summarizationStatus !==
  SummarizationStatus.UNSUPPORTED;

/**
 * Selects whether the model still has to be downloaded before the first run.
 * @param state - Redux state containing the transcriptExport slice.
 */
export const selectSummarizerNeedsDownload = (state: WithTranscriptExport) =>
  state.transcriptExport.summarizerAvailability === 'downloadable' ||
  state.transcriptExport.summarizerAvailability === 'downloading';

/**
 * Selects the current summarization status.
 * @param state - Redux state containing the transcriptExport slice.
 */
export const selectSummarizationStatus = (state: WithTranscriptExport) =>
  state.transcriptExport.summarizationStatus;

/**
 * Selects whether a summary run is in flight.
 * @param state - Redux state containing the transcriptExport slice.
 */
export const selectIsSummarizing = (state: WithTranscriptExport) =>
  state.transcriptExport.summarizationStatus ===
    SummarizationStatus.SUMMARIZING ||
  state.transcriptExport.summarizationStatus ===
    SummarizationStatus.DOWNLOADING;

/**
 * Selects section/pass progress for the run in flight, or null.
 * @param state - Redux state containing the transcriptExport slice.
 */
export const selectSummarizationProgress = (state: WithTranscriptExport) =>
  state.transcriptExport.progress;

/**
 * Selects model download progress in 0..1, or null when not downloading.
 * @param state - Redux state containing the transcriptExport slice.
 */
export const selectSummarizerDownloadProgress = (state: WithTranscriptExport) =>
  state.transcriptExport.downloadProgress;

/**
 * Selects the user-visible export error, or null when healthy. Covers both a
 * failed summary and a file that could not be saved.
 * @param state - Redux state containing the transcriptExport slice.
 */
export const selectExportErrorMessage = (state: WithTranscriptExport) =>
  state.transcriptExport.saveError ?? state.transcriptExport.summarizationError;

/**
 * Selects the last summary produced this session, so it can be saved again if
 * the browser blocked the automatic download.
 * @param state - Redux state containing the transcriptExport slice.
 */
export const selectLastSummary = (state: WithTranscriptExport) =>
  state.transcriptExport.lastSummary;

/**
 * Selects whether a summary has been generated in this session. Used to warn
 * before the first, slower run.
 * @param state - Redux state containing the transcriptExport slice.
 */
export const selectHasCompletedSummaryRun = (state: WithTranscriptExport) =>
  state.transcriptExport.hasCompletedRun;

/**
 * Redux slice for transcript and summary downloads. Written by the transcript
 * export middleware; the action creators here are the UI's entry points.
 */
export const transcriptExportSlice = createSlice({
  name: 'transcriptExport',
  initialState,
  reducers: {
    /**
     * Saves the current transcript as `transcript-YYYYMMDD-HHMMSS.txt`.
     * Handled by the middleware, which reads the transcript from the store.
     */
    downloadTranscript: (state) => {
      state.saveError = null;
    },
    /**
     * Starts an on-device summary run and saves the result as
     * `summary-YYYYMMDD-HHMMSS.txt`. Dispatched from the confirmation click so
     * it still carries user activation for the model download.
     */
    requestSummary: (state) => {
      state.saveError = null;
      state.summarizationError = null;
    },
    /** Saves the last summary again, e.g. if the browser blocked the first try. */
    downloadLastSummary: (state) => {
      state.saveError = null;
    },
    /** Cancels the run in flight. */
    cancelSummary: (state) => {
      state.progress = null;
    },
    /** Applies a summarization service state snapshot. */
    setSummarizationState: (
      state,
      action: PayloadAction<SummarizationServiceState>,
    ) => {
      state.summarizationStatus = action.payload.status;
      state.summarizerAvailability = action.payload.availability;
      state.downloadProgress = action.payload.downloadProgress;
      state.progress = action.payload.progress;
      state.summarizationError = action.payload.errorMessage;
      state.hasCompletedRun = action.payload.hasCompletedRun;
    },
    /** Records a finished summary so it can be saved again. */
    setLastSummary: (
      state,
      action: PayloadAction<{ fileName: string; text: string }>,
    ) => {
      state.lastSummary = action.payload;
    },
    /** Records that a file could not be handed to the browser. */
    setSaveError: (state, action: PayloadAction<string | null>) => {
      state.saveError = action.payload;
    },
    /** Clears whatever error is on screen. */
    dismissExportError: (state) => {
      state.saveError = null;
      state.summarizationError = null;
    },
  },
});

// Reducer for the transcriptExport slice.
export const transcriptExportReducer = transcriptExportSlice.reducer;

export const {
  downloadTranscript,
  requestSummary,
  downloadLastSummary,
  cancelSummary,
  setSummarizationState,
  setLastSummary,
  setSaveError,
  dismissExportError,
} = transcriptExportSlice.actions;
