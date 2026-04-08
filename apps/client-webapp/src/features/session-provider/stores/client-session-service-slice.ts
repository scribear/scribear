import {
  type PayloadAction,
  createAction,
  createSlice,
} from '@reduxjs/toolkit';

import type { RootState } from '#src/store/store';

import { ClientSessionServiceStatus } from '../services/client-session-service-status';

interface SessionStatus {
  transcriptionServiceConnected: boolean;
  sourceDeviceConnected: boolean;
}

/**
 * Shape of the `clientSessionService` Redux slice. Tracks the runtime
 * status of the `ClientSessionService` and the active session connection.
 */
export interface ClientSessionServiceSliceState {
  status: ClientSessionServiceStatus;
  sessionStatus: SessionStatus | null;
}

const initialState: ClientSessionServiceSliceState = {
  status: ClientSessionServiceStatus.IDLE,
  sessionStatus: null,
};

/** Selects the current `ClientSessionServiceStatus`. */
export const selectClientSessionServiceStatus = (state: RootState) =>
  state.clientSessionService.status;

/** Selects the current session connection status. */
export const selectSessionStatus = (state: RootState) =>
  state.clientSessionService.sessionStatus;

/**
 * Redux slice tracking the runtime status of the `ClientSessionService`.
 */
export const clientSessionServiceSlice = createSlice({
  name: 'clientSessionService',
  initialState,
  reducers: {
    setClientSessionServiceStatus: (
      state,
      action: PayloadAction<ClientSessionServiceStatus>,
    ) => {
      state.status = action.payload;
    },
    setSessionStatus: (state, action: PayloadAction<SessionStatus | null>) => {
      state.sessionStatus = action.payload;
    },
  },
});

export const clientSessionServiceReducer = clientSessionServiceSlice.reducer;

export const { setClientSessionServiceStatus, setSessionStatus } =
  clientSessionServiceSlice.actions;

/**
 * Action dispatched to join a session with the given join code.
 * Handled by the session service middleware.
 */
export const joinSession = createAction<string>(
  'clientSessionService/joinSession',
);

/**
 * Action dispatched to leave the current session.
 * Handled by the session service middleware.
 */
export const leaveSession = createAction('clientSessionService/leaveSession');
