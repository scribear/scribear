import { type PayloadAction, createAction, createSlice } from '@reduxjs/toolkit';

import type { RootState } from '#src/store/store';

export interface SessionControlsState {
  isPaused: boolean;
  isEndingSession: boolean;
  lastError: string | null;
}

const initialState: SessionControlsState = {
  isPaused: false,
  isEndingSession: false,
  lastError: null,
};

export const sessionControlsSlice = createSlice({
  name: 'sessionControls',
  initialState,
  reducers: {
    setPaused: (state, action: PayloadAction<boolean>) => {
      state.isPaused = action.payload;
    },
    setEndingSession: (state, action: PayloadAction<boolean>) => {
      state.isEndingSession = action.payload;
    },
    setSessionControlError: (state, action: PayloadAction<string | null>) => {
      state.lastError = action.payload;
    },
  },
});

export const requestEndSession = createAction('sessionControls/requestEndSession');

export const sessionControlsReducer = sessionControlsSlice.reducer;
export const { setPaused, setEndingSession, setSessionControlError } =
  sessionControlsSlice.actions;

export const selectIsPaused = (state: RootState) => state.sessionControls.isPaused;
export const selectIsEndingSession = (state: RootState) =>
  state.sessionControls.isEndingSession;
export const selectSessionControlError = (state: RootState) =>
  state.sessionControls.lastError;
