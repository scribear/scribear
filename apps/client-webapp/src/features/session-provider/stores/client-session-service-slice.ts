import {
  type PayloadAction,
  createAction,
  createSlice,
} from '@reduxjs/toolkit';

import type { RootState } from '#src/store/store';

import type { SessionStatusSnapshot } from '../services/client-session-service';
import {
  ClientLifecycle,
  type JoinError,
  SessionConnectionStatus,
} from '../services/client-session-service-status';

/**
 * UX-shaped state for the client app, mirroring the spec's `ClientUxState`.
 * Everything in this slice is rebuilt from runtime events on page load - no
 * tokens or socket handles ever land here. Persisted identity (refresh token
 * etc.) lives in {@link ClientSessionConfigSliceState} instead.
 */
export interface ClientSessionServiceSliceState {
  lifecycle: ClientLifecycle;
  session: {
    sessionUid: string;
    connectionStatus: SessionConnectionStatus;
    sessionStatus: SessionStatusSnapshot;
  } | null;
  joinError: JoinError | null;
  error: string | null;
}

const initialState: ClientSessionServiceSliceState = {
  lifecycle: ClientLifecycle.INITIALIZING,
  session: null,
  joinError: null,
  error: null,
};

export const selectLifecycle = (state: RootState) =>
  state.clientSessionService.lifecycle;
export const selectSession = (state: RootState) =>
  state.clientSessionService.session;
export const selectJoinError = (state: RootState) =>
  state.clientSessionService.joinError;
export const selectError = (state: RootState) =>
  state.clientSessionService.error;

/**
 * Redux slice tracking the runtime status of the {@link ClientSessionService}.
 */
export const clientSessionServiceSlice = createSlice({
  name: 'clientSessionService',
  initialState,
  reducers: {
    setLifecycle: (state, action: PayloadAction<ClientLifecycle>) => {
      state.lifecycle = action.payload;
      if (action.payload !== ClientLifecycle.ACTIVE) {
        state.session = null;
      }
    },
    setActiveSession: (state, action: PayloadAction<string | null>) => {
      if (action.payload === null) {
        state.session = null;
        return;
      }
      state.session = {
        sessionUid: action.payload,
        connectionStatus: SessionConnectionStatus.CONNECTING,
        sessionStatus: {
          transcriptionServiceConnected: false,
          sourceDeviceConnected: false,
        },
      };
    },
    setConnectionStatus: (
      state,
      action: PayloadAction<SessionConnectionStatus>,
    ) => {
      if (state.session === null) return;
      state.session.connectionStatus = action.payload;
    },
    setSessionStatus: (state, action: PayloadAction<SessionStatusSnapshot>) => {
      if (state.session === null) return;
      state.session.sessionStatus = action.payload;
    },
    setJoinError: (state, action: PayloadAction<JoinError | null>) => {
      state.joinError = action.payload;
    },
    setError: (state, action: PayloadAction<string | null>) => {
      state.error = action.payload;
    },
  },
});

export const clientSessionServiceReducer = clientSessionServiceSlice.reducer;

export const {
  setLifecycle,
  setActiveSession,
  setConnectionStatus,
  setSessionStatus,
  setJoinError,
  setError,
} = clientSessionServiceSlice.actions;

/**
 * Action dispatched to join a session with the given join code. Handled by
 * the client session service middleware.
 */
export const joinSession = createAction<string>(
  'clientSessionService/joinSession',
);

/**
 * Action dispatched to leave the current session. Handled by the client
 * session service middleware.
 */
export const leaveSession = createAction('clientSessionService/leaveSession');
