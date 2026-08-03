import {
  type PayloadAction,
  createSelector,
  createSlice,
} from '@reduxjs/toolkit';
import { v4 as uuidv4 } from 'uuid';

/** Sliding-window size for the latency moving averages. */
const LATENCY_WINDOW_SIZE = 60;

/** Which transcript a latency sample describes. */
export type LatencyKind = 'final' | 'inProgress';

/**
 * A latency sample dispatched from the session transport: `pipelineMs` is the
 * skew-free node-side pipeline latency; `e2eMs` additionally includes capture
 * and uplink (via clock-synced source timestamps) and is null when no reliable
 * offset is available.
 */
export interface LatencySample {
  kind: LatencyKind;
  pipelineMs: number;
  e2eMs: number | null;
}

interface LatencyWindow {
  samples: number[];
  average: number;
}

interface LatencyMetric {
  final: LatencyWindow;
  inProgress: LatencyWindow;
}

/**
 * Rolling latency measurements. `pipeline` (node ingress -> transcript) is
 * always populated; `e2e` (capture -> display) is only populated once the
 * source's clock has been synced to the server.
 */
export interface LatencyState {
  pipeline: LatencyMetric;
  e2e: LatencyMetric;
}

function emptyWindow(): LatencyWindow {
  return { samples: [], average: 0 };
}

function emptyMetric(): LatencyMetric {
  return { final: emptyWindow(), inProgress: emptyWindow() };
}

function emptyLatency(): LatencyState {
  return { pipeline: emptyMetric(), e2e: emptyMetric() };
}

function pushSample(window: LatencyWindow, value: number): void {
  window.samples.push(value);
  if (window.samples.length > LATENCY_WINDOW_SIZE) {
    window.samples.shift();
  }
  window.average =
    window.samples.reduce((sum, s) => sum + s, 0) / window.samples.length;
}

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
 * rendered as a stable keyed DOM node - avoiding full-paragraph re-layout
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
  latency: LatencyState;
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
  latency: emptyLatency(),
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
 * Selects the whole transcript as plain text - committed paragraphs first, then
 * the paragraph currently being built - separated by blank lines.
 *
 * Interim (in-progress) text is deliberately excluded. It is rewritten several
 * times a second and is not yet a record of anything; a transcript saved
 * mid-word would contain a guess the recogniser was about to revise. Anything
 * real reaches a committed sequence within a second or so.
 */
export const selectTranscriptText = createSelector(
  [selectCommitedSections, selectActiveSection],
  (commitedSections, activeSection) => {
    const paragraphs = commitedSections.map((section) => section.text.trim());
    const active = activeSection.sequences
      .map((sequence) => sequence.text.join(''))
      .join('')
      .trim();
    if (active !== '') paragraphs.push(active);
    return paragraphs.filter((paragraph) => paragraph !== '').join('\n\n');
  },
);

/**
 * Selects an approximate word count for the transcript, for UI that has to say
 * how much there is before spending minutes summarising it.
 */
export const selectTranscriptWordCount = createSelector(
  [selectTranscriptText],
  (text) => (text === '' ? 0 : text.split(/\s+/).length),
);

/** Skew-free pipeline latency (ms) for finalized transcripts; 0 if no samples. */
export const selectFinalPipelineLatencyMs = (state: WithTranscriptionContent) =>
  state.transcriptionContent.latency.pipeline.final.average;

/** Skew-free pipeline latency (ms) for interim transcripts; 0 if no samples. */
export const selectInProgressPipelineLatencyMs = (
  state: WithTranscriptionContent,
) => state.transcriptionContent.latency.pipeline.inProgress.average;

/** End-to-end latency (ms) for finalized transcripts; 0 until clock-synced. */
export const selectFinalE2eLatencyMs = (state: WithTranscriptionContent) =>
  state.transcriptionContent.latency.e2e.final.average;

/** End-to-end latency (ms) for interim transcripts; 0 until clock-synced. */
export const selectInProgressE2eLatencyMs = (state: WithTranscriptionContent) =>
  state.transcriptionContent.latency.e2e.inProgress.average;

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
     * Handles a combined transcript event containing optional final and in-progress data.
     * Appends final transcription if present, then sets in-progress transcription.
     */
    handleTranscript: (
      state,
      action: PayloadAction<{
        final: TranscriptionSequenceInput | null;
        inProgress: TranscriptionSequenceInput | null;
      }>,
    ) => {
      if (action.payload.final) {
        const sequence: TranscriptionSequence = {
          id: uuidv4(),
          ...action.payload.final,
        };
        state.activeSection.sequences.push(sequence);
        state.finalizedTranscription.push(sequence);
        state.inProgressTranscription = null;
      }
      if (action.payload.inProgress) {
        state.inProgressTranscription = action.payload.inProgress;
      }
    },
    /**
     * Records a latency sample into the rolling windows. `pipelineMs` always
     * counts; `e2eMs` counts only when present and non-negative (a negative
     * value signals residual clock skew and is discarded).
     */
    recordLatency: (state, action: PayloadAction<LatencySample>) => {
      const { kind, pipelineMs, e2eMs } = action.payload;
      pushSample(state.latency.pipeline[kind], pipelineMs);
      if (e2eMs !== null && e2eMs >= 0) {
        pushSample(state.latency.e2e[kind], e2eMs);
      }
    },
    /**
     * Resets all transcription content back to the initial empty state.
     */
    clearTranscription: (state) => {
      state.commitedSections = [];
      state.activeSection = { id: uuidv4(), sequences: [] };
      state.finalizedTranscription = [];
      state.inProgressTranscription = null;
      state.latency = emptyLatency();
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
  handleTranscript,
  recordLatency,
  clearTranscription,
} = transcriptionContentSlice.actions;
