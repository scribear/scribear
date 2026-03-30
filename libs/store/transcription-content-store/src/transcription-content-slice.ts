import { type PayloadAction, createSlice } from '@reduxjs/toolkit';
import { v4 as uuidv4 } from 'uuid';

/**
 * A sequence of transcribed text tokens with optional word-level timing data.
 * Each committed sequence has a stable `id` so it can be rendered as a keyed
 * DOM node without re-creating existing elements.
 */
export interface TranscriptionSequence {
  id: string;
  text: string[];
  starts?: number[] | null;
  ends?: number[] | null;
}

/**
 * Input shape for dispatching a new transcription sequence. The `id` is
 * generated internally by the reducer and should not be provided by callers.
 */
export type TranscriptionSequenceInput = Omit<TranscriptionSequence, 'id'>;

/**
 * A committed paragraph of transcription text with a stable identity.
 * The `id` is a UUID assigned at creation so React can track DOM nodes
 * across re-renders without re-creating existing paragraph elements.
 */
export interface TranscriptionSection {
  // Sections need a static id so React doesn't recreate existing paragraphs in DOM
  id: string;
  text: string;
}

/**
 * The active (in-progress) paragraph being built from finalized sequences.
 * Sequences are kept individually rather than concatenated so each can be
 * rendered as a stable keyed DOM node — avoiding full-paragraph re-layout
 * as the active section grows.
 */
export interface ActiveSection {
  id: string;
  sequences: TranscriptionSequence[];
}

/**
 * State shape for the transcription content slice. Tracks both committed
 * (finalized) sections and the currently active paragraph being built, as
 * well as the in-progress (interim) transcription from the provider.
 */
export interface TranscriptionContentSlice {
  commitedSections: TranscriptionSection[];
  activeSection: ActiveSection;
  finalizedTranscription: TranscriptionSequence[];
  inProgressTranscription: TranscriptionSequenceInput | null;
}

/**
 * Minimal Redux state shape required by transcription content selectors.
 */
interface WithTranscriptionContent {
  transcriptionContent: TranscriptionContentSlice;
}

const initialState: TranscriptionContentSlice = {
  commitedSections: [],
  activeSection: { id: uuidv4(), sequences: [] },
  finalizedTranscription: [],
  inProgressTranscription: null,
};

/**
 * Selects all committed (paragraph-broken) transcription sections.
 */
export const selectCommitedSections = (state: WithTranscriptionContent) =>
  state.transcriptionContent.commitedSections;

/**
 * Selects the currently active transcription section being populated.
 */
export const selectActiveSection = (state: WithTranscriptionContent) =>
  state.transcriptionContent.activeSection;

/**
 * Selects the concatenated text of the current in-progress (interim) transcription.
 */
export const selectInProgressTranscriptionText = (
  state: WithTranscriptionContent,
) => {
  if (state.transcriptionContent.inProgressTranscription === null) return '';
  return state.transcriptionContent.inProgressTranscription.text.join('');
};

/**
 * Redux slice managing all transcription content, including committed paragraph
 * sections, the active paragraph being built, and the current interim transcription.
 */
export const transcriptionContentSlice = createSlice({
  name: 'transcriptionContent',
  initialState,
  reducers: {
    /**
     * Commits the active section as a completed paragraph and starts a new one.
     * No-ops if the active section has no sequences.
     */
    commitParagraphBreak: (state) => {
      if (state.activeSection.sequences.length === 0) return;
      state.commitedSections.push({
        id: state.activeSection.id,
        text: state.activeSection.sequences
          .map((s) => s.text.join(''))
          .join(''),
      });
      state.activeSection = { id: uuidv4(), sequences: [] };
    },
    /**
     * Appends a finalized transcription sequence to the active section and
     * the finalized transcript log, clearing any in-progress transcription.
     * The sequence `id` is generated internally.
     */
    appendFinalizedTranscription: (
      state,
      action: PayloadAction<TranscriptionSequenceInput>,
    ) => {
      const sequence: TranscriptionSequence = {
        id: uuidv4(),
        ...action.payload,
      };
      state.activeSection.sequences.push(sequence);
      state.finalizedTranscription.push(sequence);
      state.inProgressTranscription = null;
    },
    /**
     * Promotes the current in-progress transcription to finalized status,
     * appending it to the active section. No-ops if there is no in-progress transcription.
     * The sequence `id` is generated internally.
     */
    commitInProgressTranscription: (state) => {
      if (state.inProgressTranscription === null) return;
      const sequence: TranscriptionSequence = {
        id: uuidv4(),
        ...state.inProgressTranscription,
      };
      state.activeSection.sequences.push(sequence);
      state.finalizedTranscription.push(sequence);
      state.inProgressTranscription = null;
    },
    /**
     * Replaces the current in-progress (interim) transcription with a new sequence.
     * Used to update the live preview as the provider emits partial results.
     */
    replaceInProgressTranscription: (
      state,
      action: PayloadAction<TranscriptionSequenceInput>,
    ) => {
      state.inProgressTranscription = action.payload;
    },
    /**
     * Resets all transcription content back to the initial empty state.
     */
    clearTranscription: (state) => {
      state.commitedSections = [];
      state.activeSection = { id: uuidv4(), sequences: [] };
      state.finalizedTranscription = [];
      state.inProgressTranscription = null;
    },
  },
});

// Reducer for the transcriptionContent slice.
export const transcriptionContentReducer = transcriptionContentSlice.reducer;

export const {
  commitParagraphBreak,
  appendFinalizedTranscription,
  commitInProgressTranscription,
  replaceInProgressTranscription,
  clearTranscription,
} = transcriptionContentSlice.actions;
