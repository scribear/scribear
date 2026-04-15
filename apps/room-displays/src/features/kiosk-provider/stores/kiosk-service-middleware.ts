import { type Middleware } from '@reduxjs/toolkit';

import {
  selectIsMicrophoneServiceActive,
  setMicrophoneServiceStatus,
} from '@scribear/microphone-store';
import type { MicrophoneService } from '@scribear/microphone-store';
import {
  appInitialization,
  rememberRehydrated,
} from '@scribear/redux-remember-store';
import {
  clearTranscription,
  handleTranscript,
} from '@scribear/transcription-content-store';
import { createSessionManagerClient } from '@scribear/session-manager-client';

import type { RootState } from '#src/store/store';

import {
  requestEndSession,
  setEndingSession,
  setSessionControlError,
} from '#src/features/session-controls/stores/session-controls-slice';

import { KioskService } from '../services/kiosk-service';
import {
  selectActiveSessionId,
  selectDeviceName,
  selectPrevEventId,
  selectSessionRefreshToken,
  setActiveSessionId,
  setDeviceName,
  setPrevEventId,
  setSessionRefreshToken,
} from './kiosk-config-slice';
import {
  registerDevice,
  setJoinCode,
  setKioskServiceStatus,
  setSessionStatus,
} from './kiosk-service-slice';

// Module-level reference for HMR cleanup.
let _activeKioskService: KioskService | null = null;

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    _activeKioskService?.removeAllListeners();
    _activeKioskService?.deactivate();
    _activeKioskService = null;
  });
}

/**
 * Reads the current microphone activation state from the Redux store and
 * forwards it to the kiosk service by calling `mute` or `unmute`.
 */
const syncMuteState = (kioskService: KioskService, state: RootState) => {
  const isMicrophoneServiceActive = selectIsMicrophoneServiceActive(state);
  if (isMicrophoneServiceActive) {
    kioskService.unmute();
  } else {
    kioskService.mute();
  }
};

/**
 * Redux middleware that manages the `KioskService` lifecycle in response to
 * store actions. Creates the service, wires up event listeners that dispatch
 * transcription and state actions, activates on initialization and rehydration,
 * and syncs the microphone mute state whenever the microphone service status changes.
 */
export const createKioskServiceMiddleware =
  (microphoneService: MicrophoneService): Middleware<object, RootState> =>
  (store) => {
    // Clean up any previous instance (handles HMR module replacement).
    _activeKioskService?.removeAllListeners();
    _activeKioskService?.deactivate();

    const kioskService = new KioskService(microphoneService);
    _activeKioskService = kioskService;

    kioskService.on('statusChange', (status) => {
      store.dispatch(setKioskServiceStatus(status));
    });
    kioskService.on('transcript', (event) => {
      store.dispatch(handleTranscript(event));
    });
    kioskService.on('sessionStarted', (sessionId) => {
      store.dispatch(setActiveSessionId(sessionId));
    });
    kioskService.on('sessionEnded', () => {
      store.dispatch(setActiveSessionId(null));
      store.dispatch(setSessionStatus(null));
      store.dispatch(clearTranscription());
    });
    kioskService.on('sessionStatus', (status) => {
      store.dispatch(setSessionStatus(status));
    });
    kioskService.on('deviceRegistered', (deviceName) => {
      store.dispatch(setDeviceName(deviceName));
    });
    kioskService.on('deviceUnregistered', () => {
      store.dispatch(setDeviceName(null));
    });
    kioskService.on('prevEventIdUpdated', (eventId) => {
      store.dispatch(setPrevEventId(eventId));
    });
    kioskService.on('sessionRefreshTokenUpdated', (token) => {
      store.dispatch(setSessionRefreshToken(token));
    });
    kioskService.on('joinCodeUpdated', (data) => {
      store.dispatch(setJoinCode(data));
    });

    return (next) => (action) => {
      const result = next(action);

      if (appInitialization.match(action)) {
        const state = store.getState();
        kioskService.activate(
          selectDeviceName(state),
          selectActiveSessionId(state),
          selectPrevEventId(state),
          selectSessionRefreshToken(state),
        );
        syncMuteState(kioskService, state);
      }

      if (rememberRehydrated.match(action)) {
        const state = store.getState();
        kioskService.activate(
          selectDeviceName(state),
          selectActiveSessionId(state),
          selectPrevEventId(state),
          selectSessionRefreshToken(state),
        );
        syncMuteState(kioskService, state);
      }

      if (setMicrophoneServiceStatus.match(action)) {
        syncMuteState(kioskService, store.getState());
      }

      if (registerDevice.match(action)) {
        void kioskService.registerDevice(action.payload);
      }

      if (requestEndSession.match(action)) {
        const state = store.getState();
        const sessionId = selectActiveSessionId(state);
        if (!sessionId) return result;

        const sessionManagerClient = createSessionManagerClient(
          window.location.origin,
        );
        void (async () => {
          store.dispatch(setEndingSession(true));
          store.dispatch(setSessionControlError(null));
          try {
            const apiKey = import.meta.env.VITE_SESSION_MANAGER_API_KEY;
            if (!apiKey) {
              store.dispatch(
                setSessionControlError(
                  'Missing VITE_SESSION_MANAGER_API_KEY; cannot end session early.',
                ),
              );
              return;
            }
            const [response, error] = await sessionManagerClient.endSession({
              headers: { authorization: `Bearer ${apiKey}` },
              body: { sessionId },
            });
            if (error || response.status !== 200) {
              store.dispatch(setSessionControlError('Failed to end session.'));
            }
          } finally {
            store.dispatch(setEndingSession(false));
          }
        })();
      }

      return result;
    };
  };
