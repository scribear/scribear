/**
 * Redux slice for storing transcription text
 */
import { type PayloadAction, createSlice } from '@reduxjs/toolkit';
import { v4 as uuidv4 } from 'uuid';

import type { RootState } from '#src/stores/store';

export interface TranscriptionSequence {
  text: string[];
  starts?: number[];
  ends?: number[];
}

export interface TranscriptionSection {
  // Sections need a static id so React doesn't recreate existing paragraphs in DOM
  id: string;
  text: string;
}

export interface LatencyPayload {
  type: 'final' | 'in_progress';
  latency: number;
}

export interface TranscriptionContentSlice {
  commitedSections: TranscriptionSection[];
  activeSection: TranscriptionSection;
  finalizedTranscription: TranscriptionSequence[];
  inProgressTranscription: TranscriptionSequence | null;
  recentFinalLatencies: number[];
  recentInProgressLatencies: number[];
  averageFinalLatency: number;
  averageInProgressLatency: number;
}

const initialState: TranscriptionContentSlice = {
  commitedSections: [],
  activeSection: { id: uuidv4(), text: '' },
  finalizedTranscription: [],
  inProgressTranscription: null,
  recentFinalLatencies: [],
  recentInProgressLatencies: [],
  averageFinalLatency: 0,
  averageInProgressLatency: 0,
};

// Selectors
export const selectCommitedSections = (state: RootState) =>
  state.transcriptionContent.commitedSections;
export const selectActiveSection = (state: RootState) =>
  state.transcriptionContent.activeSection;
export const selectInProgressTranscriptionText = (state: RootState) => {
  if (state.transcriptionContent.inProgressTranscription === null) return '';
  return state.transcriptionContent.inProgressTranscription.text.join('');
};

export const transcriptionContentSlice = createSlice({
  name: 'transcriptionContent',
  initialState,
  reducers: {
    commitParagraphBreak: (state) => {
      // Don't add a paragraph is current paragraph is empty
      if (state.activeSection.text === '') return;

      state.commitedSections.push(state.activeSection);
      state.activeSection = {
        id: uuidv4(),
        text: '',
      };
    },
    appendFinalizedTranscription: (
      state,
      action: PayloadAction<TranscriptionSequence>,
    ) => {
      state.activeSection.text += action.payload.text.join('');
      state.finalizedTranscription.push(action.payload);
      state.inProgressTranscription = null;
    },
    commitInProgressTranscription: (state) => {
      if (state.inProgressTranscription === null) return;
      state.activeSection.text += state.inProgressTranscription.text.join('');
      state.finalizedTranscription.push(state.inProgressTranscription);
      state.inProgressTranscription = null;
    },
    replaceInProgressTranscription: (
      state,
      action: PayloadAction<TranscriptionSequence>,
    ) => {
      state.inProgressTranscription = action.payload;
    },
    recordLatency: (state, action: PayloadAction<LatencyPayload>) => {
      const WINDOW_SIZE = 50; // only calculate average of 50 times recently
      const { type, latency } = action.payload;

      if (type === 'final') {
        state.recentFinalLatencies.push(latency);
        if (state.recentFinalLatencies.length > WINDOW_SIZE) {
          state.recentFinalLatencies.shift();
        }
        state.averageFinalLatency =
          state.recentFinalLatencies.reduce((a, b) => a + b, 0) /
          state.recentFinalLatencies.length;
      } else {
        state.recentInProgressLatencies.push(latency);
        if (state.recentInProgressLatencies.length > WINDOW_SIZE) {
          state.recentInProgressLatencies.shift();
        }
        state.averageInProgressLatency =
          state.recentInProgressLatencies.reduce((a, b) => a + b, 0) /
          state.recentInProgressLatencies.length;
      }
    },
    clearTranscription: (state) => {
      state.commitedSections = [];
      state.activeSection = {
        id: uuidv4(),
        text: '',
      };
      state.finalizedTranscription = [];
      state.inProgressTranscription = null;
      state.recentFinalLatencies = [];
      state.recentInProgressLatencies = [];
      state.averageFinalLatency = 0;
      state.averageInProgressLatency = 0;
    },
  },
});
export const transcriptionContentReducer = transcriptionContentSlice.reducer;

// Action Creators
export const {
  commitParagraphBreak,
  appendFinalizedTranscription,
  commitInProgressTranscription,
  replaceInProgressTranscription,
  clearTranscription,
  recordLatency,
} = transcriptionContentSlice.actions;
