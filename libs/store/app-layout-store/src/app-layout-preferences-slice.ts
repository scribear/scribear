import { createSlice } from '@reduxjs/toolkit';

/**
 * State shape for the app layout preferences slice, which stores user
 * preferences related to the overall application layout.
 */
export interface AppLayoutPreferencesSlice {
  isHeaderHideEnabled: boolean;
}

interface WithAppLayoutPreferences {
  appLayoutPreferences: AppLayoutPreferencesSlice;
}

const initialState: AppLayoutPreferencesSlice = {
  isHeaderHideEnabled: false,
};

/**
 * Selects whether the auto-hide header behavior is enabled.
 * @param state - The Redux state containing the appLayoutPreferences slice.
 * @returns `true` if the header should be hidden when inactive.
 */
export const selectIsHeaderHideEnabled = (state: WithAppLayoutPreferences) =>
  state.appLayoutPreferences.isHeaderHideEnabled;

/**
 * Redux slice managing user preferences for the app layout, including
 * whether the header should automatically hide during inactivity.
 */
export const appLayoutPreferencesSlice = createSlice({
  name: 'appLayoutPreferences',
  initialState,
  reducers: {
    /**
     * Toggles the auto-hide header preference on or off.
     */
    toggleHeaderHide: (state) => {
      state.isHeaderHideEnabled = !state.isHeaderHideEnabled;
    },
  },
});

// Reducer for the appLayoutPreferences slice.
export const appLayoutPreferencesReducer = appLayoutPreferencesSlice.reducer;

// Action that toggles whether the app header is automatically hidden.
export const { toggleHeaderHide } = appLayoutPreferencesSlice.actions;
