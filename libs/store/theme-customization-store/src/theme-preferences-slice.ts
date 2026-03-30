import { type PayloadAction, createSlice } from '@reduxjs/toolkit';

import type { ThemeColors } from './types.js';

// The default background color used when no theme preference has been set.
export const BASE_BACKGROUND_COLOR = '#000000';
// The default accent color used when no theme preference has been set.
export const BASE_ACCENT_COLOR = '#8b0000';
// The default transcription text color used when no theme preference has been set.
export const BASE_TRANSCRIPTION_COLOR = '#ffff00';

/**
 * State shape for the theme preferences slice, which stores the user's
 * currently selected color theme values.
 */
export interface ThemePreferencesSlice {
  backgroundColor: string;
  accentColor: string;
  transcriptionColor: string;
}

/**
 * Minimal Redux state shape required by theme preference selectors.
 */
interface WithThemePreferences {
  themePreferences: ThemePreferencesSlice;
}

const initialState: ThemePreferencesSlice = {
  backgroundColor: BASE_BACKGROUND_COLOR,
  accentColor: BASE_ACCENT_COLOR,
  transcriptionColor: BASE_TRANSCRIPTION_COLOR,
};

/**
 * Selects the current background color from theme preferences.
 * @param state - The Redux state containing the themePreferences slice.
 * @returns The background color as a CSS hex string.
 */
export const selectBackgroundColor = (state: WithThemePreferences) =>
  state.themePreferences.backgroundColor;

/**
 * Selects the current accent color from theme preferences.
 * @param state - The Redux state containing the themePreferences slice.
 * @returns The accent color as a CSS hex string.
 */
export const selectAccentColor = (state: WithThemePreferences) =>
  state.themePreferences.accentColor;

/**
 * Selects the current transcription text color from theme preferences.
 * @param state - The Redux state containing the themePreferences slice.
 * @returns The transcription color as a CSS hex string.
 */
export const selectTranscriptionColor = (state: WithThemePreferences) =>
  state.themePreferences.transcriptionColor;

/**
 * Redux slice managing the user's color theme preferences, including
 * background, accent, and transcription text colors.
 */
export const themePreferencesSlice = createSlice({
  name: 'themePreferences',
  initialState,
  reducers: {
    /**
     * Sets the background color to the given CSS color string.
     */
    setBackgroundColor: (state, action: PayloadAction<string>) => {
      state.backgroundColor = action.payload;
    },
    /**
     * Sets the accent color to the given CSS color string.
     */
    setAccentColor: (state, action: PayloadAction<string>) => {
      state.accentColor = action.payload;
    },
    /**
     * Sets the transcription text color to the given CSS color string.
     */
    setTranscriptionColor: (state, action: PayloadAction<string>) => {
      state.transcriptionColor = action.payload;
    },
    /**
     * Applies all three colors from a {@link ThemeColors} object at once.
     */
    setTheme: (state, action: PayloadAction<ThemeColors>) => {
      state.backgroundColor = action.payload.backgroundColor;
      state.accentColor = action.payload.accentColor;
      state.transcriptionColor = action.payload.transcriptionColor;
    },
  },
});

// Reducer for the themePreferences slice.
export const themePreferencesReducer = themePreferencesSlice.reducer;

export const {
  setBackgroundColor,
  setAccentColor,
  setTranscriptionColor,
  setTheme,
} = themePreferencesSlice.actions;
