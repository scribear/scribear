import { type Middleware } from '@reduxjs/toolkit';

import { rememberRehydrated } from '@scribear/redux-remember-store';
import {
  clearTranscription,
  handleTranscript,
} from '@scribear/transcription-content-store';

import type { RootState } from '#src/store/store';

import { ClientSessionService } from '../services/client-session-service';
import { ClientLifecycle } from '../services/client-session-service-status';
import {
  selectClientId,
  selectJoinCode,
  selectSessionRefreshToken,
  selectSessionUid,
  setJoinCode,
  setSessionIdentity,
} from './client-session-config-slice';
import {
  joinSession,
  leaveSession,
  setActiveSession,
  setConnectionStatus,
  setError,
  setJoinError,
  setLifecycle,
  setSessionStatus,
} from './client-session-service-slice';

// Module-level reference for HMR cleanup.
let _activeService: ClientSessionService | null = null;

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    _activeService?.removeAllListeners();
    _activeService?.stop();
    _activeService = null;
  });
}

/**
 * Redux middleware that owns the {@link ClientSessionService} lifecycle. The
 * service is constructed once per store and started on rehydration so the
 * `INITIALIZING` flow runs as soon as the persisted identity is available.
 * Service events fan out into store dispatches; store actions tagged for the
 * client (`joinSession`, `leaveSession`) drive service methods.
 */
export const createClientSessionServiceMiddleware =
  (): Middleware<object, RootState> => (store) => {
    _activeService?.removeAllListeners();
    _activeService?.stop();

    const service = new ClientSessionService();
    _activeService = service;

    service.on('lifecycleChange', (lifecycle) => {
      store.dispatch(setLifecycle(lifecycle));
      // Clear in-memory transcript content whenever we leave ACTIVE so a new
      // session starts on a clean slate.
      if (lifecycle !== ClientLifecycle.ACTIVE) {
        store.dispatch(clearTranscription());
      }
    });
    service.on('sessionIdentity', (identity) => {
      store.dispatch(setSessionIdentity(identity));
      store.dispatch(setActiveSession(identity?.sessionUid ?? null));
    });
    service.on('connectionStatus', (status) => {
      store.dispatch(setConnectionStatus(status));
    });
    service.on('sessionStatus', (status) => {
      store.dispatch(setSessionStatus(status));
    });
    service.on('transcript', (event) => {
      store.dispatch(handleTranscript(event));
    });
    service.on('joinError', (joinError) => {
      store.dispatch(setJoinError(joinError));
    });
    service.on('error', (message) => {
      store.dispatch(setError(message));
    });

    const startFromPersistedState = () => {
      const state = store.getState();
      const sessionUid = selectSessionUid(state);
      const sessionRefreshToken = selectSessionRefreshToken(state);
      const clientId = selectClientId(state);

      if (
        sessionUid !== null &&
        sessionRefreshToken !== null &&
        clientId !== null
      ) {
        service.start({ sessionUid, sessionRefreshToken, clientId });
      } else {
        service.start(null);
      }
    };

    const tryJoinFromConfig = () => {
      const state = store.getState();
      const joinCode = selectJoinCode(state);
      if (joinCode === null) return;
      store.dispatch(setJoinCode(null));
      void service.joinSession(joinCode.trim().toUpperCase());
    };

    return (next) => (action) => {
      const result = next(action);

      // Wait for rehydrate before starting: the service needs persisted
      // session identity (refresh token, sessionUid, clientId) which is only
      // available after redux-remember has loaded localStorage.
      if (rememberRehydrated.match(action)) {
        startFromPersistedState();
        tryJoinFromConfig();
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
