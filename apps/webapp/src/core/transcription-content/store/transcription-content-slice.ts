/**
 * Redux slice for storing transcription text
 */
import { type PayloadAction, createSlice } from '@reduxjs/toolkit';

import type { RootState } from '@/stores/store';

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

export interface TranscriptionContentSlice {
  commitedSections: TranscriptionSection[];
  activeSection: TranscriptionSection;
  finalizedTranscription: TranscriptionSequence[];
  inProgressTranscription: TranscriptionSequence | null;
}

const initialState: TranscriptionContentSlice = {
  commitedSections: [],
  activeSection: { id: crypto.randomUUID(), text: '' },
  finalizedTranscription: [],
  inProgressTranscription: null,
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
        id: crypto.randomUUID(),
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
    clearTranscription: (state) => {
      state.commitedSections = [];
      state.activeSection = {
        id: crypto.randomUUID(),
        text: '',
      };
      state.finalizedTranscription = [];
      state.inProgressTranscription = null;
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
} = transcriptionContentSlice.actions;
