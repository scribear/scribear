import { type Middleware } from '@reduxjs/toolkit';

import { appInitialization } from '@scribear/redux-remember-store';
import {
  type TranscriptionContentSlice,
  selectTranscriptText,
} from '@scribear/transcription-content-store';

import { type SummarizationService } from './summarization-service.js';
import {
  type TranscriptExportSlice,
  cancelSummary,
  downloadLastSummary,
  downloadTranscript,
  requestSummary,
  setLastSummary,
  setSaveError,
  setSummarizationState,
} from './transcript-export-slice.js';
import {
  buildSummaryFile,
  buildTranscriptFile,
  downloadTextFile,
  summaryFileName,
  transcriptFileName,
} from './transcript-files.js';

/**
 * Minimal Redux state shape required by the transcript export middleware.
 */
interface WithTranscriptExportState {
  transcriptExport: TranscriptExportSlice;
  transcriptionContent: TranscriptionContentSlice;
}

const SAVE_FAILED_MESSAGE =
  'Your browser would not save the file. Check whether downloads are blocked for this site.';

/**
 * Bridges a {@link SummarizationService} to the store and performs the actual
 * file saves.
 *
 * `requestSummary` starts the run synchronously inside the dispatch, so a
 * dispatch from a click handler still carries the user activation Chromium
 * requires before a `create()` that downloads - and here the download is about
 * 1.8 GB, so it will be required on first use.
 *
 * The finished summary is both saved immediately and kept in the store. The
 * save happens minutes after the click that asked for it, by which point the
 * page no longer has user activation and a browser may refuse the download; the
 * retained copy is what lets the user ask again with a fresh click.
 *
 * @param service - The summarization service instance to drive.
 */
export const createTranscriptExportMiddleware =
  (
    service: SummarizationService,
  ): Middleware<object, WithTranscriptExportState> =>
  (store) => {
    service.on('stateChange', (state) => {
      store.dispatch(setSummarizationState(state));
    });

    const save = (fileName: string, text: string) => {
      const saved = downloadTextFile(fileName, text);
      store.dispatch(setSaveError(saved ? null : SAVE_FAILED_MESSAGE));
      return saved;
    };

    return (next) => (action) => {
      const result = next(action);

      if (appInitialization.match(action)) {
        store.dispatch(setSummarizationState(service.state));
        // Presence of the API is not a capability check - ask the browser
        // whether the model can actually run here before offering anything.
        if (service.isApiPresent) void service.checkAvailability();
      }

      if (downloadTranscript.match(action)) {
        const transcript = selectTranscriptText(store.getState());
        save(transcriptFileName(new Date()), buildTranscriptFile(transcript));
      }

      if (requestSummary.match(action)) {
        const transcript = selectTranscriptText(store.getState());
        void service.summarize(transcript).then((summary) => {
          if (!summary) return;
          const generatedAt = new Date();
          const fileName = summaryFileName(generatedAt);
          const text = buildSummaryFile(summary, generatedAt);
          store.dispatch(setLastSummary({ fileName, text }));
          save(fileName, text);
        });
      }

      if (downloadLastSummary.match(action)) {
        const last = store.getState().transcriptExport.lastSummary;
        if (last) save(last.fileName, last.text);
      }

      if (cancelSummary.match(action)) {
        service.cancel();
      }

      return result;
    };
  };
