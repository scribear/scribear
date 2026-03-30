import {
  type PayloadAction,
  createSelector,
  createSlice,
} from '@reduxjs/toolkit';

import { TRANSCRIPTION_DISPLAY_CONFG } from './config/transcription-display-bounds.js';
import {
  clampFloorStepBounds,
  clampRoundedStepBounds,
} from './utils/clamp-stepped-bounds.js';
import { deriveDisplayPreferences } from './utils/derive-display-preferences.js';

/**
 * State shape for the transcription display preferences slice. Stores the
 * user's typographic and layout preferences for the transcription display area.
 */
export interface TranscriptionDisplayPreferencesSlice {
  wordSpacingEm: number;
  fontSizePx: number;
  lineHeightMultipler: number;
  targetVerticalPositionPx: number;
  targetDisplayLines: number;
}

/**
 * Minimal Redux state shape required by transcription display preference selectors.
 */
interface WithTranscriptionDisplayPreferences {
  transcriptionDisplayPreferences: TranscriptionDisplayPreferencesSlice;
}

const initialState: TranscriptionDisplayPreferencesSlice = {
  wordSpacingEm: 0.25,
  fontSizePx: 32,
  lineHeightMultipler: 1.5,
  targetVerticalPositionPx: 120,
  targetDisplayLines: 8,
};

/**
 * Selects the word spacing preference in em units.
 * @param state - The Redux state containing the transcriptionDisplayPreferences slice.
 */
export const selectWordSpacingEm = (
  state: WithTranscriptionDisplayPreferences,
) => state.transcriptionDisplayPreferences.wordSpacingEm;

/**
 * Selects the font size preference in pixels.
 * @param state - The Redux state containing the transcriptionDisplayPreferences slice.
 */
export const selectFontSizePx = (state: WithTranscriptionDisplayPreferences) =>
  state.transcriptionDisplayPreferences.fontSizePx;

/**
 * Selects the line height multiplier preference (applied to font size).
 * @param state - The Redux state containing the transcriptionDisplayPreferences slice.
 */
export const selectLineHeightMultipler = (
  state: WithTranscriptionDisplayPreferences,
) => state.transcriptionDisplayPreferences.lineHeightMultipler;

/**
 * Selects the user's target vertical position (distance from top of container) in pixels.
 * @param state - The Redux state containing the transcriptionDisplayPreferences slice.
 */
export const selectTargetVerticalPositionPx = (
  state: WithTranscriptionDisplayPreferences,
) => state.transcriptionDisplayPreferences.targetVerticalPositionPx;

/**
 * Selects the user's target number of visible transcription lines.
 * @param state - The Redux state containing the transcriptionDisplayPreferences slice.
 */
export const selectTargetDisplayLines = (
  state: WithTranscriptionDisplayPreferences,
) => state.transcriptionDisplayPreferences.targetDisplayLines;

/**
 * Memoized selector that computes the rendered line height in pixels by
 * multiplying font size by the line height multiplier.
 */
export const selectLineHeightPx = createSelector(
  [selectFontSizePx, selectLineHeightMultipler],
  (fontSizePx, lineHeightMultipler) =>
    Math.round(fontSizePx * lineHeightMultipler),
);

const selectContainerHeightPx = (
  _state: WithTranscriptionDisplayPreferences,
  { containerHeightPx }: { containerHeightPx: number },
) => containerHeightPx;

/**
 * Memoized selector that derives the actual display preferences bounded to
 * the available container height. Takes `containerHeightPx` as a second argument.
 * @returns An object with `numDisplayLines` and `verticalPositionPx` clamped to fit the container.
 */
export const selectBoundedDisplayPreferences = createSelector(
  [
    selectLineHeightPx,
    selectTargetVerticalPositionPx,
    selectTargetDisplayLines,
    selectContainerHeightPx,
  ],
  deriveDisplayPreferences,
);

/**
 * Memoized selector that computes the valid min/max range for the vertical
 * position preference given the current line height and container height.
 * Takes `containerHeightPx` as a second argument.
 * @returns An object with `minVerticalPositionPx` and `maxVerticalPositionPx`.
 */
export const selectVerticalPositionBoundsPx = createSelector(
  [selectLineHeightPx, selectContainerHeightPx],
  (lineHeightPx, containerHeightPx) => {
    const minTextHeightPx =
      lineHeightPx * TRANSCRIPTION_DISPLAY_CONFG.displayLines.min;
    return {
      minVerticalPositionPx: TRANSCRIPTION_DISPLAY_CONFG.verticalPositionPx.min,
      maxVerticalPositionPx: clampFloorStepBounds(
        containerHeightPx - minTextHeightPx,
        TRANSCRIPTION_DISPLAY_CONFG.verticalPositionPx,
      ),
    };
  },
);

/**
 * Memoized selector that computes the valid min/max range for the number of
 * display lines given the current line height, vertical position, and container height.
 * Takes `containerHeightPx` as a second argument.
 * @returns An object with `minNumDisplayLines` and `maxNumDisplayLines`.
 */
export const selectNumDisplayLinesBounds = createSelector(
  [selectLineHeightPx, selectTargetVerticalPositionPx, selectContainerHeightPx],
  (lineHeightPx, targetVerticalPositionPx, containerHeightPx) => ({
    minNumDisplayLines: TRANSCRIPTION_DISPLAY_CONFG.displayLines.min,
    maxNumDisplayLines: clampFloorStepBounds(
      (containerHeightPx - targetVerticalPositionPx) / lineHeightPx,
      TRANSCRIPTION_DISPLAY_CONFG.displayLines,
    ),
  }),
);

/**
 * Redux slice managing the user's transcription display preferences, including
 * font size, word spacing, line height, vertical position, and number of display lines.
 * All setters clamp and snap values to their configured step bounds.
 */
export const transcriptionDisplayPreferencesSlice = createSlice({
  name: 'transcriptionDisplayPreferences',
  initialState,
  reducers: {
    /**
     * Sets the word spacing, clamped to valid step bounds.
     */
    setWordSpacingEm: (state, action: PayloadAction<number>) => {
      state.wordSpacingEm = clampRoundedStepBounds(
        action.payload,
        TRANSCRIPTION_DISPLAY_CONFG.wordSpacingEm,
      );
    },
    /**
     * Sets the font size in pixels, clamped to valid step bounds.
     */
    setFontSizePx: (state, action: PayloadAction<number>) => {
      state.fontSizePx = clampRoundedStepBounds(
        action.payload,
        TRANSCRIPTION_DISPLAY_CONFG.fontSizePx,
      );
    },
    /**
     * Sets the line height multiplier, clamped to valid step bounds.
     */
    setLineHeightMultipler: (state, action: PayloadAction<number>) => {
      state.lineHeightMultipler = clampRoundedStepBounds(
        action.payload,
        TRANSCRIPTION_DISPLAY_CONFG.lineHeightMultipler,
      );
    },
    /**
     * Sets the target vertical position in pixels, clamped to valid step bounds.
     */
    setTargetVerticalPositionPx: (state, action: PayloadAction<number>) => {
      state.targetVerticalPositionPx = clampRoundedStepBounds(
        action.payload,
        TRANSCRIPTION_DISPLAY_CONFG.verticalPositionPx,
      );
    },
    /**
     * Sets the target number of display lines, clamped to valid step bounds.
     */
    setTargetDisplayLines: (state, action: PayloadAction<number>) => {
      state.targetDisplayLines = clampRoundedStepBounds(
        action.payload,
        TRANSCRIPTION_DISPLAY_CONFG.displayLines,
      );
    },
    /**
     * Resets all transcription display preferences back to their initial default values.
     */
    resetTranscriptionDisplayPreferences: (state) => {
      state.wordSpacingEm = initialState.wordSpacingEm;
      state.fontSizePx = initialState.fontSizePx;
      state.lineHeightMultipler = initialState.lineHeightMultipler;
      state.targetVerticalPositionPx = initialState.targetVerticalPositionPx;
      state.targetDisplayLines = initialState.targetDisplayLines;
    },
  },
});

// Reducer for the transcriptionDisplayPreferences slice.
export const transcriptionDisplayPreferencesReducer =
  transcriptionDisplayPreferencesSlice.reducer;

export const {
  setWordSpacingEm,
  setFontSizePx,
  setLineHeightMultipler,
  setTargetVerticalPositionPx,
  setTargetDisplayLines,
  resetTranscriptionDisplayPreferences,
} = transcriptionDisplayPreferencesSlice.actions;
