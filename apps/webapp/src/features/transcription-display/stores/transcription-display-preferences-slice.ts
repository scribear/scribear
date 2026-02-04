/**
 * Redux slice for saving user preferences for transcription display preferences
 */
import {
  type PayloadAction,
  createSelector,
  createSlice,
} from '@reduxjs/toolkit';

import type { RootState } from '@/stores/store';

import { TRANSCRIPTION_DISPLAY_CONFG } from '../config/transcription-display-bounds';
import {
  clampFloorStepBounds,
  clampRoundedStepBounds,
} from '../utils/clamp-stepped-bounds';
import { deriveDisplayPreferences } from '../utils/derive-display-preferences';

export interface TranscriptionDisplayPreferencesSlice {
  wordSpacingEm: number;
  fontSizePx: number;
  lineHeightMultipler: number;
  targetVerticalPositionPx: number;
  targetDisplayLines: number;
}

const initialState: TranscriptionDisplayPreferencesSlice = {
  wordSpacingEm: 0.25,
  fontSizePx: 32,
  lineHeightMultipler: 1.5,
  targetVerticalPositionPx: 120,
  targetDisplayLines: 8,
};

// Selectors
export const selectWordSpacingEm = (state: RootState) =>
  state.transcriptionDisplayPreferences.wordSpacingEm;
export const selectFontSizePx = (state: RootState) =>
  state.transcriptionDisplayPreferences.fontSizePx;
export const selectLineHeightMultipler = (state: RootState) =>
  state.transcriptionDisplayPreferences.lineHeightMultipler;
// Compute line height in px
export const selectLineHeightPx = createSelector(
  [selectFontSizePx, selectLineHeightMultipler],
  (fontSizePx, lineHeightMultipler) => {
    return Math.round(fontSizePx * lineHeightMultipler);
  },
);

const selectTargetVerticalPositionPx = (state: RootState) =>
  state.transcriptionDisplayPreferences.targetVerticalPositionPx;
const selectTargetDisplayLines = (state: RootState) =>
  state.transcriptionDisplayPreferences.targetDisplayLines;
const selectContainerHeightPx = (
  state: RootState,
  { containerHeightPx }: { containerHeightPx: number },
) => containerHeightPx;

// Compute valid display preferences based on target preferences and current container height
export const selectBoundedDisplayPreferences = createSelector(
  [
    selectLineHeightPx,
    selectTargetVerticalPositionPx,
    selectTargetDisplayLines,
    selectContainerHeightPx,
  ],
  deriveDisplayPreferences,
);

// Bound vertical position based on container height and other display preferences
export const selectVerticalPositionBoundsPx = createSelector(
  [selectLineHeightPx, selectContainerHeightPx],
  (lineHeightPx, containerHeightPx) => {
    // Must leave enough space for single line
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

// Bound number of display lines based on container height and all other display preferences
export const selectNumDisplayLinesBounds = createSelector(
  [selectLineHeightPx, selectTargetVerticalPositionPx, selectContainerHeightPx],
  (lineHeightPx, targetVerticalPositionPx, containerHeightPx) => {
    return {
      minNumDisplayLines: TRANSCRIPTION_DISPLAY_CONFG.displayLines.min,
      maxNumDisplayLines: clampFloorStepBounds(
        (containerHeightPx - targetVerticalPositionPx) / lineHeightPx,
        TRANSCRIPTION_DISPLAY_CONFG.displayLines,
      ),
    };
  },
);

export const transcriptionDisplayPreferencesSlice = createSlice({
  name: 'transcriptionDisplayPreferences',
  initialState,
  reducers: {
    setWordSpacingEm: (state, action: PayloadAction<number>) => {
      state.wordSpacingEm = clampRoundedStepBounds(
        action.payload,
        TRANSCRIPTION_DISPLAY_CONFG.wordSpacingEm,
      );
    },
    setFontSizePx: (state, action: PayloadAction<number>) => {
      state.fontSizePx = clampRoundedStepBounds(
        action.payload,
        TRANSCRIPTION_DISPLAY_CONFG.fontSizePx,
      );
    },
    setLineHeightMultipler: (state, action: PayloadAction<number>) => {
      state.lineHeightMultipler = clampRoundedStepBounds(
        action.payload,
        TRANSCRIPTION_DISPLAY_CONFG.lineHeightMultipler,
      );
    },
    setTargetVerticalPositionPx: (state, action: PayloadAction<number>) => {
      state.targetVerticalPositionPx = clampRoundedStepBounds(
        action.payload,
        TRANSCRIPTION_DISPLAY_CONFG.verticalPositionPx,
      );
    },
    setTargetDisplayLines: (state, action: PayloadAction<number>) => {
      state.targetDisplayLines = clampRoundedStepBounds(
        action.payload,
        TRANSCRIPTION_DISPLAY_CONFG.displayLines,
      );
    },
    resetTranscriptionDisplayPreferences: (state) => {
      state.wordSpacingEm = initialState.wordSpacingEm;
      state.fontSizePx = initialState.fontSizePx;
      state.lineHeightMultipler = initialState.lineHeightMultipler;
      state.targetVerticalPositionPx = initialState.targetVerticalPositionPx;
      state.targetDisplayLines = initialState.targetDisplayLines;
    },
  },
});
export const transcriptionDisplayPreferencesReducer =
  transcriptionDisplayPreferencesSlice.reducer;

// Action creators
export const {
  setWordSpacingEm,
  setFontSizePx,
  setLineHeightMultipler,
  setTargetVerticalPositionPx,
  setTargetDisplayLines,
  resetTranscriptionDisplayPreferences,
} = transcriptionDisplayPreferencesSlice.actions;
