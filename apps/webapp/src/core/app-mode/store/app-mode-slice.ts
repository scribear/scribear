/**
 * Redux slice for holding application mode
 */
import { type PayloadAction, createSlice } from '@reduxjs/toolkit';

import { DEFAULT_APP_MODE } from '#src/config/app-mode-paths';
import type { RootState } from '#src/stores/store';
import { AppMode } from '#src/types/app-mode';

export interface ApplicationModeSlice {
  appMode: AppMode;
}

const initialState: ApplicationModeSlice = {
  appMode: DEFAULT_APP_MODE,
};

// Selectors
export const selectAppMode = (state: RootState) => state.appMode.appMode;

export const appModeSlice = createSlice({
  name: 'appMode',
  initialState,
  reducers: {
    appModeChange: (state, newAppMode: PayloadAction<AppMode>) => {
      state.appMode = newAppMode.payload;
    },
  },
});
export const appModeReducer = appModeSlice.reducer;

// Action Creators
export const { appModeChange } = appModeSlice.actions;
