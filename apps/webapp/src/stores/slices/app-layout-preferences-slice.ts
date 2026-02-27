/**
 * Redux slice for saving user preferences for transcription layout
 */
import { createSlice } from '@reduxjs/toolkit';

import type { RootState } from '#src/stores/store';

export interface AooLayoutPreferencesSlice {
  isHeaderHideEnabled: boolean;
}

const initialState: AooLayoutPreferencesSlice = {
  isHeaderHideEnabled: false,
};

// Selectors
export const selectIsHeaderHideEnabled = (state: RootState) =>
  state.appLayoutPreferences.isHeaderHideEnabled;

export const appLayoutPreferencesSlice = createSlice({
  name: 'appLayoutPreferences',
  initialState,
  reducers: {
    toggleHeaderHide: (state) => {
      state.isHeaderHideEnabled = !state.isHeaderHideEnabled;
    },
  },
});
export const appLayoutPreferencesReducer = appLayoutPreferencesSlice.reducer;

// Action Creators
export const { toggleHeaderHide } = appLayoutPreferencesSlice.actions;
