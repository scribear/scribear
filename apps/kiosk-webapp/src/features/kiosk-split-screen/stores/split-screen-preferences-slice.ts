/**
 * Redux slice for storing user split screen preferences
 * This slice is saved to local storage
 */
import { type PayloadAction, createSlice } from '@reduxjs/toolkit';

import type { RootState } from '#src/store/store';

/**
 * Shape of the `splitScreenPreferences` Redux slice. Stores the user's preferred
 * right-panel width as a fraction of the total container width, and whether the
 * right panel is currently open. This slice is persisted to `localStorage`.
 */
export interface SplitScreenPreferencesSlice {
  targetRightPanelWidthPercent: number;
  isRightPanelOpen: boolean;
}

const initialState: SplitScreenPreferencesSlice = {
  targetRightPanelWidthPercent: 0.35,
  isRightPanelOpen: true,
};

/**
 * Selects the user's preferred right-panel width as a value between 0 and 1.
 */
export const selectTargetRightPanelWidthPercent = (state: RootState) =>
  state.splitScreenPreferences.targetRightPanelWidthPercent;
/**
 * Selects whether the right panel is currently open.
 */
export const selectIsRightPanelOpen = (state: RootState) =>
  state.splitScreenPreferences.isRightPanelOpen;

/**
 * Redux slice managing the user's split-screen layout preferences, including
 * the right panel width percentage and open/closed state.
 */
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
// Reducer for the splitScreenPreferences slice.
export const splitScreenPreferencesReducer =
  splitScreenPreferencesSlice.reducer;

// Action creators for the splitScreenPreferences slice.
export const { setTargetRightPanelWidthPercent, toggleRightPanelIsOpen } =
  splitScreenPreferencesSlice.actions;
