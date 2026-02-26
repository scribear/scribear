/**
 * Custom Redux middleware for syncing microphone service with redux state
 */
import { type Middleware } from '@reduxjs/toolkit';

import { appModeChange } from '#src/core/app-mode/store/app-mode-slice';
import { rememberRehydrated } from '#src/stores/slices/redux-remember-slice';
import { type RootState, appInitialization } from '#src/stores/store';

import { microphoneService } from '../services/microphone-service';
import {
  activateMicrophone,
  deactivateMicrophone,
  selectIsTargetMicrophoneActive,
} from './microphone-preferences-slice';
import { setMicrophoneServiceStatus } from './microphone-service-slice';

const syncTargetStatus = (state: RootState) => {
  const isTargetMicrophoneActive = selectIsTargetMicrophoneActive(state);

  if (isTargetMicrophoneActive) {
    void microphoneService.activateMicrophone();
  } else {
    microphoneService.deactivateMicrophone();
  }
};

export const microphoneServiceMiddleware: Middleware<object, RootState> = (
  store,
) => {
  microphoneService.on('statusChange', (newStatus) => {
    store.dispatch(setMicrophoneServiceStatus(newStatus));
  });

  return (next) => (action) => {
    const result = next(action);

    // One time initialization after store is created
    if (appInitialization.match(action)) {
      store.dispatch(setMicrophoneServiceStatus(microphoneService.status));
      syncTargetStatus(store.getState());
    }

    // After rehydration, attempt to enter target state
    if (rememberRehydrated.match(action)) {
      syncTargetStatus(store.getState());
    }

    if (appModeChange.match(action)) {
      syncTargetStatus(store.getState());
    }

    if (activateMicrophone.match(action)) {
      syncTargetStatus(store.getState());
    }

    if (deactivateMicrophone.match(action)) {
      syncTargetStatus(store.getState());
    }

    return result;
  };
};
