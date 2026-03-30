import { type Middleware } from '@reduxjs/toolkit';

import {
  appInitialization,
  rememberRehydrated,
} from '../../redux-remember-store/src/index.js';
import {
  type MicrophonePreferencesSlice,
  activateMicrophone,
  deactivateMicrophone,
  selectIsPreferMicrophoneActive,
} from './microphone-preferences-slice.js';
import {
  type MicrophoneServiceSliceState,
  setMicrophoneServiceStatus,
} from './microphone-service-slice.js';
import { type MicrophoneService } from './microphone-service.js';

/**
 * Minimal Redux state shape required by the microphone service middleware.
 */
interface WithMicrophoneState {
  microphonePreferences: MicrophonePreferencesSlice;
  microphoneService: MicrophoneServiceSliceState;
}

/**
 * Creates Redux middleware that bridges a {@link MicrophoneService} instance with the Redux store.
 *
 * On setup, it subscribes to service `statusChange` events and dispatches
 * `setMicrophoneServiceStatus` to keep the store in sync. It also reacts to:
 * - `appInitialization` - syncs the initial service status into the store.
 * - `rememberRehydrated` - re-syncs the service after persisted preferences are restored.
 * - `activateMicrophone` / `deactivateMicrophone` - drives the service when the user's preference changes.
 */
export const createMicrophoneServiceMiddleware =
  (service: MicrophoneService): Middleware<object, WithMicrophoneState> =>
  (store) => {
    const syncTargetStatus = (state: WithMicrophoneState) => {
      if (selectIsPreferMicrophoneActive(state)) {
        void service.activateMicrophone();
      } else {
        service.deactivateMicrophone();
      }
    };

    service.on('statusChange', (newStatus) => {
      store.dispatch(setMicrophoneServiceStatus(newStatus));
    });

    return (next) => (action) => {
      const result = next(action);

      if (appInitialization.match(action)) {
        store.dispatch(setMicrophoneServiceStatus(service.status));
      }

      if (rememberRehydrated.match(action)) {
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
