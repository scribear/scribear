import { type Middleware } from '@reduxjs/toolkit';

import {
  appInitialization,
  rememberRehydrated,
} from '@scribear/redux-remember-store';
import { handleTranscript } from '@scribear/transcription-content-store';

import type { RootState } from '#src/store/store';

import { ClientSessionService } from '../services/client-session-service';
import {
  selectSessionId,
  selectSessionRefreshToken,
  setSessionId,
  setSessionRefreshToken,
} from './client-session-config-slice';
import {
  joinSession,
  leaveSession,
  setClientSessionServiceStatus,
  setSessionStatus,
} from './client-session-service-slice';

// Module-level reference for HMR cleanup.
let _activeService: ClientSessionService | null = null;

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    _activeService?.removeAllListeners();
    _activeService?.leaveSession();
    _activeService = null;
  });
}

/**
 * Redux middleware that manages the `ClientSessionService` lifecycle.
 * Wires up event listeners that dispatch transcription and state actions,
 * resumes sessions on rehydration, and handles join/leave actions.
 */
export const createClientSessionServiceMiddleware =
  (): Middleware<object, RootState> => (store) => {
    // Clean up any previous instance (handles HMR module replacement).
    _activeService?.removeAllListeners();
    _activeService?.leaveSession();

    const service = new ClientSessionService();
    _activeService = service;

    service.on('statusChange', (status) => {
      store.dispatch(setClientSessionServiceStatus(status));
    });
    service.on('transcript', (event) => {
      store.dispatch(handleTranscript(event));
    });
    service.on('sessionStatus', (status) => {
      store.dispatch(setSessionStatus(status));
    });
    service.on('sessionIdUpdated', (sessionId) => {
      store.dispatch(setSessionId(sessionId));
    });
    service.on('sessionRefreshTokenUpdated', (token) => {
      store.dispatch(setSessionRefreshToken(token));
    });

    const tryResumeSession = () => {
      const state = store.getState();
      const sessionId = selectSessionId(state);
      const sessionRefreshToken = selectSessionRefreshToken(state);

      if (sessionId && sessionRefreshToken) {
        service.resumeSession(sessionId, sessionRefreshToken);
      }
    };

    return (next) => (action) => {
      const result = next(action);

      if (appInitialization.match(action)) {
        tryResumeSession();
      }

      if (rememberRehydrated.match(action)) {
        tryResumeSession();
      }

      if (joinSession.match(action)) {
        void service.joinSession(action.payload);
      }

      if (leaveSession.match(action)) {
        service.leaveSession();
      }

      return result;
    };
  };
