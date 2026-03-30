import type { Middleware } from '@reduxjs/toolkit';

import {
  selectIsMicrophoneServiceActive,
  setMicrophoneServiceStatus,
} from '@scribear/microphone-store';
import {
  appInitialization,
  rememberRehydrated,
} from '@scribear/redux-remember-store';
import {
  appendFinalizedTranscription,
  clearTranscription,
  commitInProgressTranscription,
  commitParagraphBreak,
  replaceInProgressTranscription,
} from '@scribear/transcription-content-store';

import type { RootState } from '#src/store/store';

import { providerService } from '../services/provider-service';
import { ProviderId } from '../services/providers/provider-registry';
import {
  selectProviderConfig,
  updateProviderConfig,
} from './provider-config-slice';
import {
  selectTargetProviderId,
  setPreferredProviderId,
} from './provider-preferences-slice';
import {
  type SetProviderStatusPayload,
  setProviderStatus,
} from './provider-status-slice';

/**
 * Reads the current microphone activation state from the Redux store and
 * forwards it to the provider service by calling `mute` or `unmute`.
 *
 * @param state - The current Redux root state snapshot.
 */
const syncMicState = (state: RootState) => {
  const isMicrophoneServiceActive = selectIsMicrophoneServiceActive(state);

  if (isMicrophoneServiceActive) {
    providerService.unmute();
  } else {
    providerService.mute();
  }
};

/**
 * Reads the preferred provider ID and its config from the Redux store and
 * instructs the provider service to switch to that provider, or deactivates it
 * when the preferred ID is `null`.
 *
 * @param state - The current Redux root state snapshot.
 */
const syncTargetProvider = (state: RootState) => {
  const targetProviderId = selectTargetProviderId(state);

  if (targetProviderId) {
    const config = selectProviderConfig(state, targetProviderId);
    void providerService.switchProvider(targetProviderId, config);
  } else {
    providerService.deactivate();
  }
};

/**
 * Redux middleware that keeps the singleton `providerService` in sync with the
 * Redux store. Registers provider event listeners that dispatch transcription
 * actions, and reacts to store actions (rehydration, mic state changes, provider
 * preference and config updates) to activate, deactivate, or reconfigure the
 * active transcription provider.
 */
export const providerServiceMiddleware: Middleware<object, RootState> = (
  store,
) => {
  providerService.on('commitParagraphBreak', () => {
    store.dispatch(commitParagraphBreak());
  });
  providerService.on('appendFinalizedTranscription', (sequence) => {
    store.dispatch(appendFinalizedTranscription(sequence));
  });
  providerService.on('replaceInProgressTranscription', (sequence) => {
    store.dispatch(replaceInProgressTranscription(sequence));
  });
  providerService.on('clearTranscription', () => {
    store.dispatch(clearTranscription());
  });
  providerService.on('statusChange', (providerId, newStatus) => {
    store.dispatch(
      setProviderStatus({ providerId, newStatus } as SetProviderStatusPayload),
    );
  });

  return (next) => (action) => {
    const result = next(action);

    // One time initialization after store is created
    if (appInitialization.match(action)) {
      const providerStatuses = providerService.providerStatuses;

      for (const providerId of Object.values(ProviderId)) {
        store.dispatch(
          setProviderStatus({
            providerId: providerId,
            newStatus: providerStatuses[providerId],
          } as SetProviderStatusPayload),
        );
      }

      const state = store.getState();
      syncMicState(state);
    }

    // After rehydration, attempt to enter target state
    if (rememberRehydrated.match(action)) {
      const state = store.getState();
      syncMicState(state);
      syncTargetProvider(store.getState());
    }

    if (setMicrophoneServiceStatus.match(action)) {
      syncMicState(store.getState());
    }

    if (setPreferredProviderId.match(action)) {
      store.dispatch(commitInProgressTranscription());
      store.dispatch(commitParagraphBreak());

      syncTargetProvider(store.getState());
    }

    if (updateProviderConfig.match(action)) {
      store.dispatch(commitInProgressTranscription());
      store.dispatch(commitParagraphBreak());

      const state = store.getState();
      const targetProviderId = selectTargetProviderId(state);

      if (targetProviderId) {
        const config = selectProviderConfig(state, targetProviderId);
        void providerService.updateConfig(targetProviderId, config);
      } else {
        providerService.deactivate();
      }
    }

    return result;
  };
};
