import { type PayloadAction, createSlice } from '@reduxjs/toolkit';

import {
  BASE_ACCENT_COLOR,
  BASE_BACKGROUND_COLOR,
  BASE_TRANSCRIPTION_COLOR,
} from '#src/config/base-theme';
import type { RootState } from '#src/stores/store';

import type { ThemeColors } from '../types/theme';

export interface ThemePreferencesSlice {
  backgroundColor: string;
  accentColor: string;
  transcriptionColor: string;
}

const initialState: ThemePreferencesSlice = {
  backgroundColor: BASE_BACKGROUND_COLOR,
  accentColor: BASE_ACCENT_COLOR,
  transcriptionColor: BASE_TRANSCRIPTION_COLOR,
};

// Selectors
export const selectBackgroundColor = (state: RootState) =>
  state.themePreferences.backgroundColor;
export const selectAccentColor = (state: RootState) =>
  state.themePreferences.accentColor;
export const selectTranscriptionColor = (state: RootState) =>
  state.themePreferences.transcriptionColor;

export const themePreferencesSlice = createSlice({
  name: 'themePreferences',
  initialState,
  reducers: {
    setBackgroundColor: (state, action: PayloadAction<string>) => {
      state.backgroundColor = action.payload;
    },
    setAccentColor: (state, action: PayloadAction<string>) => {
      state.accentColor = action.payload;
    },
    setTranscriptionColor: (state, action: PayloadAction<string>) => {
      state.transcriptionColor = action.payload;
    },
    setTheme: (state, action: PayloadAction<ThemeColors>) => {
      state.backgroundColor = action.payload.backgroundColor;
      state.accentColor = action.payload.accentColor;
      state.transcriptionColor = action.payload.transcriptionColor;
    },
  },
});
export const themePreferencesReducer = themePreferencesSlice.reducer;

// Action Creators
export const {
  setBackgroundColor,
  setAccentColor,
  setTranscriptionColor,
  setTheme,
} = themePreferencesSlice.actions;
