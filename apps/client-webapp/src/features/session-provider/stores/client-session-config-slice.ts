import { type PayloadAction, createSlice } from '@reduxjs/toolkit';

import type { RootState } from '#src/store/store';

/**
 * Persisted shape of the client session config slice. Survives page reload
 * via redux-remember (localStorage) so the client can resume a session
 * without prompting the user for a join code again.
 *
 * Per the client app spec, three values make up the persisted identity:
 * `sessionUid`, `sessionRefreshToken`, and `clientId`. `joinCode` is a
 * one-shot inbound channel from URL config - the middleware consumes it
 * once and immediately clears it.
 */
export interface ClientSessionConfigSliceState {
  sessionUid: string | null;
  sessionRefreshToken: string | null;
  clientId: string | null;
  joinCode: string | null;
}

const initialState: ClientSessionConfigSliceState = {
  sessionUid: null,
  sessionRefreshToken: null,
  clientId: null,
  joinCode: null,
};

/** Selects the active session UID, or `null` if not in a session. */
export const selectSessionUid = (state: RootState) =>
  state.clientSessionConfig.sessionUid;

/** Selects the persisted session refresh token used for resume. */
export const selectSessionRefreshToken = (state: RootState) =>
  state.clientSessionConfig.sessionRefreshToken;

/** Selects the server-assigned client ID for the current session. */
export const selectClientId = (state: RootState) =>
  state.clientSessionConfig.clientId;

/** Selects the join code provided via URL config. */
export const selectJoinCode = (state: RootState) =>
  state.clientSessionConfig.joinCode;

/**
 * Redux slice storing the client session identity persisted to localStorage.
 */
export const clientSessionConfigSlice = createSlice({
  name: 'clientSessionConfig',
  initialState,
  reducers: {
    setSessionIdentity: (
      state,
      action: PayloadAction<{
        sessionUid: string;
        sessionRefreshToken: string;
        clientId: string;
      } | null>,
    ) => {
      if (action.payload === null) {
        state.sessionUid = null;
        state.sessionRefreshToken = null;
        state.clientId = null;
        return;
      }
      state.sessionUid = action.payload.sessionUid;
      state.sessionRefreshToken = action.payload.sessionRefreshToken;
      state.clientId = action.payload.clientId;
    },
    setJoinCode: (state, action: PayloadAction<string | null>) => {
      state.joinCode = action.payload;
    },
  },
});

export const clientSessionConfigReducer = clientSessionConfigSlice.reducer;

export const { setSessionIdentity, setJoinCode } =
  clientSessionConfigSlice.actions;
