import type { Middleware } from '@reduxjs/toolkit';

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
  appendFinalizedTranscription,
  clearTranscription,
  commitInProgressTranscription,
  commitParagraphBreak,
  replaceInProgressTranscription,
} from '@scribear/transcription-content-store';

import type { RootState } from '#src/store/store';

import { ProviderService } from '../services/provider-service';
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
import { setIsLoadingProvider } from './provider-ui-slice';

// Module-level reference for HMR cleanup.
let _activeProviderService: ProviderService | null = null;

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    _activeProviderService?.removeAllListeners();
    _activeProviderService?.deactivate();
    _activeProviderService = null;
  });
}

/**
 * Reads the current microphone activation state from the Redux store and
 * forwards it to the provider service by calling `mute` or `unmute`.
 */
const syncMicState = (providerService: ProviderService, state: RootState) => {
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
 */
const syncTargetProvider = (
  providerService: ProviderService,
  state: RootState,
) => {
  const targetProviderId = selectTargetProviderId(state);

  if (targetProviderId) {
    const config = selectProviderConfig(state, targetProviderId);
    void providerService.switchProvider(targetProviderId, config);
  } else {
    providerService.deactivate();
  }
};

/**
 * Redux middleware that keeps a `ProviderService` instance in sync with the
 * Redux store. The service is created here (not as a module-level singleton)
 * so that it has access to the store at construction time. Registers provider
 * event listeners that dispatch transcription and UI actions, and reacts to
 * store actions to activate, deactivate, or reconfigure the active provider.
 */
export const createProviderServiceMiddleware =
  (microphoneService: MicrophoneService): Middleware<object, RootState> =>
  (store) => {
    // Clean up any previous instance (handles HMR module replacement).
    _activeProviderService?.removeAllListeners();
    _activeProviderService?.deactivate();

    const providerService = new ProviderService(microphoneService);
    _activeProviderService = providerService;

    providerService.on('loadingStarted', () => {
      store.dispatch(setIsLoadingProvider(true));
    });
    providerService.on('loadingComplete', () => {
      store.dispatch(setIsLoadingProvider(false));
    });
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
        setProviderStatus({
          providerId,
          newStatus,
        } as SetProviderStatusPayload),
      );
    });

    return (next) => (action) => {
      const result = next(action);

      // One-time initialization after store is created.
      if (appInitialization.match(action)) {
        syncMicState(providerService, store.getState());
      }

      if (setMicrophoneServiceStatus.match(action)) {
        syncMicState(providerService, store.getState());
      }

      // After rehydration, attempt to enter target state.
      if (rememberRehydrated.match(action)) {
        syncTargetProvider(providerService, store.getState());
      }

      if (setPreferredProviderId.match(action)) {
        store.dispatch(commitInProgressTranscription());
        store.dispatch(commitParagraphBreak());

        syncTargetProvider(providerService, store.getState());
      }

      if (updateProviderConfig.match(action)) {
        const state = store.getState();
        const targetProviderId = selectTargetProviderId(state);

        if (action.payload.providerId === targetProviderId) {
          store.dispatch(commitInProgressTranscription());
          store.dispatch(commitParagraphBreak());

          const config = selectProviderConfig(state, targetProviderId);
          void providerService.updateConfig(targetProviderId, config);
        }
      }

      return result;
    };
  };
