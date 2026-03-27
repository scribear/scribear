/**
 * Redux slice for storing user split screen preferences
 * This slice is saved to local storage
 */
import { type PayloadAction, createSlice } from '@reduxjs/toolkit';

import type { RootState } from '#src/stores/store.js';

export interface SplitScreenPreferencesSlice {
  targetRightPanelWidthPercent: number;
  isRightPanelOpen: boolean;
}

const initialState: SplitScreenPreferencesSlice = {
  targetRightPanelWidthPercent: 0.35,
  isRightPanelOpen: true,
};

// Selectors
export const selectTargetRightPanelWidthPercent = (state: RootState) =>
  state.splitScreenPreferences.targetRightPanelWidthPercent;
export const selectIsRightPanelOpen = (state: RootState) =>
  state.splitScreenPreferences.isRightPanelOpen;

export const splitScreenPreferencesSlice = createSlice({
  name: 'splitScreenPreferences',
  initialState,
  reducers: {
    setTargetRightPanelWidthPercent: (state, action: PayloadAction<number>) => {
      state.targetRightPanelWidthPercent = Math.min(
        1,
        Math.max(0, action.payload),
      );
    },
    toggleRightPanelIsOpen: (state) => {
      state.isRightPanelOpen = !state.isRightPanelOpen;
    },
  },
});
export const splitScreenPreferencesReducer =
  splitScreenPreferencesSlice.reducer;

// Action Creators
export const { setTargetRightPanelWidthPercent, toggleRightPanelIsOpen } =
  splitScreenPreferencesSlice.actions;
