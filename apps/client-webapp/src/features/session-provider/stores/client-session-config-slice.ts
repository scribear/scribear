import { type PayloadAction, createSlice } from '@reduxjs/toolkit';

import type { RootState } from '#src/store/store';

/**
 * Shape of the `clientSessionConfig` Redux slice. Stores the active session ID
 * and refresh token so the client can reconnect after page refresh.
 */
export interface ClientSessionConfigSliceState {
  sessionId: string | null;
  sessionRefreshToken: string | null;
}

const initialState: ClientSessionConfigSliceState = {
  sessionId: null,
  sessionRefreshToken: null,
};

/** Selects the active session ID, or `null` if not in a session. */
export const selectSessionId = (state: RootState) =>
  state.clientSessionConfig.sessionId;

/** Selects the persisted session refresh token for reconnection. */
export const selectSessionRefreshToken = (state: RootState) =>
  state.clientSessionConfig.sessionRefreshToken;

/**
 * Redux slice storing the client session state persisted to localStorage.
 */
export const clientSessionConfigSlice = createSlice({
  name: 'clientSessionConfig',
  initialState,
  reducers: {
    setSessionId: (state, action: PayloadAction<string | null>) => {
      state.sessionId = action.payload;
    },
    setSessionRefreshToken: (state, action: PayloadAction<string | null>) => {
      state.sessionRefreshToken = action.payload;
    },
  },
});

export const clientSessionConfigReducer = clientSessionConfigSlice.reducer;

export const { setSessionId, setSessionRefreshToken } =
  clientSessionConfigSlice.actions;
