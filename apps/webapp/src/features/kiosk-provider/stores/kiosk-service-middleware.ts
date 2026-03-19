/**
 * Custom Redux middleware for syncing kiosk service with redux state
 */
import { type Middleware } from '@reduxjs/toolkit';

import {
  appModeChange,
  selectAppMode,
} from '#src/core/app-mode/store/app-mode-slice';
import { microphoneService } from '#src/core/microphone/services/microphone-service.js';
import {
  selectIsMicrophoneServiceActive,
  setMicrophoneServiceStatus,
} from '#src/core/microphone/stores/microphone-service-slice';
import { rememberRehydrated } from '#src/stores/slices/redux-remember-slice';
import { type RootState, appInitialization } from '#src/stores/store';
import { AppMode } from '#src/types/app-mode';

import { KioskService } from '../services/kiosk-service';
import { registerDevice } from './kiosk-service-slice';

export const kioskServiceMiddleware: Middleware<object, RootState> = (
  store,
) => {
  const kioskService = new KioskService(store, microphoneService);

  const syncAppState = (state: RootState) => {
    const appMode = selectAppMode(state);

    if (appMode === AppMode.KIOSK) {
      kioskService.activate();
    } else {
      kioskService.deactivate();
    }
  };

  const syncMuteState = (state: RootState) => {
    const isMicrophoneServiceActive = selectIsMicrophoneServiceActive(state);
    if (isMicrophoneServiceActive) {
      kioskService.unmute();
    } else {
      kioskService.mute();
    }
  };

  return (next) => (action) => {
    const result = next(action);

    // One time initialization after store is created
    if (appInitialization.match(action)) {
      const state = store.getState();
      syncAppState(state);
      syncMuteState(state);
    }

    // After rehydration, attempt to enter target state
    if (rememberRehydrated.match(action)) {
      const state = store.getState();
      syncAppState(state);
      syncMuteState(state);
    }

    if (appModeChange.match(action)) {
      const state = store.getState();
      syncAppState(state);
      syncMuteState(state);
    }

    if (setMicrophoneServiceStatus.match(action)) {
      syncMuteState(store.getState());
    }

    if (registerDevice.match(action)) {
      void kioskService.registerDevice(action.payload);
    }

    return result;
  };
};
