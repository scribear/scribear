import { type Middleware } from '@reduxjs/toolkit';

import {
  type MicrophoneService,
  selectIsMicrophoneServiceActive,
  setMicrophoneServiceStatus,
} from '@scribear/microphone-store';
import { appInitialization } from '@scribear/redux-remember-store';
import { handleTranscript } from '@scribear/transcription-content-store';

import type { RootState } from '#src/store/store';

import { KioskService } from '../services/kiosk-service';
import {
  activateDevice,
  setActiveSession,
  setConnectionStatus,
  setDevice,
  setError,
  setJoinCodes,
  setLifecycle,
  setRegistrationError,
  setRoom,
  setSessionStatus,
  setSessions,
} from './kiosk-slice';

// Module-level reference for HMR cleanup.
let _activeKioskService: KioskService | null = null;

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    _activeKioskService?.removeAllListeners();
    _activeKioskService?.stop();
    _activeKioskService = null;
  });
}

/**
 * Read the microphone activation flag from Redux and forward it to the
 * kiosk service as mute / unmute. Source devices use this to gate audio
 * capture; display devices ignore it.
 */
const syncMuteState = (kioskService: KioskService, state: RootState) => {
  if (selectIsMicrophoneServiceActive(state)) {
    kioskService.unmute();
  } else {
    kioskService.mute();
  }
};

/**
 * Redux middleware that owns the {@link KioskService} lifecycle. The service
 * is constructed once per store and starts immediately so the
 * `INITIALIZING` flow runs as soon as the page loads. Service events fan
 * out into store dispatches; store actions tagged for the kiosk
 * (`activateDevice`, microphone status) drive service methods.
 */
export const createKioskMiddleware =
  (microphoneService: MicrophoneService): Middleware<object, RootState> =>
  (store) => {
    _activeKioskService?.removeAllListeners();
    _activeKioskService?.stop();

    const kioskService = new KioskService(microphoneService);
    _activeKioskService = kioskService;

    kioskService.on('lifecycleChange', (lifecycle) => {
      store.dispatch(setLifecycle(lifecycle));
    });
    kioskService.on('deviceInfo', (device) => {
      store.dispatch(setDevice(device));
    });
    kioskService.on('roomInfo', (room) => {
      store.dispatch(setRoom(room));
    });
    kioskService.on('scheduleUpdated', (sessions) => {
      store.dispatch(setSessions(sessions));
    });
    kioskService.on('activeSession', (info) => {
      store.dispatch(setActiveSession(info));
    });
    kioskService.on('connectionStatus', (status) => {
      store.dispatch(setConnectionStatus(status));
    });
    kioskService.on('sessionStatus', (status) => {
      store.dispatch(setSessionStatus(status));
    });
    kioskService.on('transcript', (event) => {
      store.dispatch(handleTranscript(event));
    });
    kioskService.on('joinCode', (codes) => {
      store.dispatch(setJoinCodes(codes));
    });
    kioskService.on('registrationError', (message) => {
      store.dispatch(setRegistrationError(message));
    });
    kioskService.on('error', (message) => {
      store.dispatch(setError(message));
    });

    return (next) => (action) => {
      const result = next(action);

      // Start the service on `appInitialization` rather than during
      // middleware setup: `start()` synchronously emits teardown events,
      // and Redux forbids dispatching while middleware is being constructed.
      if (appInitialization.match(action)) {
        kioskService.start();
        syncMuteState(kioskService, store.getState());
      }
      if (activateDevice.match(action)) {
        void kioskService.activateDevice(action.payload);
      }
      if (setMicrophoneServiceStatus.match(action)) {
        syncMuteState(kioskService, store.getState());
      }

      return result;
    };
  };
