/**
 * Custom Redux middleware for syncing kiosk service with redux state
 */
import { type Middleware } from '@reduxjs/toolkit';

import {
  selectIsMicrophoneServiceActive,
  setMicrophoneServiceStatus,
} from '@scribear/microphone-store';
import {
  appInitialization,
  rememberRehydrated,
} from '@scribear/redux-remember-store';

import { appMicrophoneService } from '#src/app-microphone-service';
import type { RootState } from '#src/store/store';

import { KioskService } from '../services/kiosk-service';
import { registerDevice } from './kiosk-service-slice';

/**
 * Redux middleware that manages the `KioskService` lifecycle in response to
 * store actions. Activates the service on initialization and rehydration,
 * syncs the microphone mute state whenever the microphone service status changes,
 * and delegates device registration to `KioskService.registerDevice`.
 */
export const kioskServiceMiddleware: Middleware<object, RootState> = (
  store,
) => {
  const kioskService = new KioskService(store, appMicrophoneService);

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

    if (appInitialization.match(action)) {
      kioskService.activate();
      syncMuteState(store.getState());
    }

    if (rememberRehydrated.match(action)) {
      kioskService.activate();
      syncMuteState(store.getState());
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
