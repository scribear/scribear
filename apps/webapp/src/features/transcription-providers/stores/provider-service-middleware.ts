import type { Middleware } from '@reduxjs/toolkit';

import { appModeChange } from '@/core/app-mode/store/app-mode-slice';
import {
  selectIsMicrophoneServiceActive,
  setMicrophoneServiceStatus,
} from '@/core/microphone/stores/microphone-service-slice';
import {
  appendFinalizedTranscription,
  clearTranscription,
  commitInProgressTranscription,
  commitParagraphBreak,
  replaceInProgressTranscription,
} from '@/core/transcription-content/store/transcription-content-slice';
import { rememberRehydrated } from '@/stores/slices/redux-remember-slice';
import { type RootState, appInitialization } from '@/stores/store';

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

const syncMicState = (state: RootState) => {
  const isMicrophoneServiceActive = selectIsMicrophoneServiceActive(state);

  if (isMicrophoneServiceActive) {
    providerService.unmute();
  } else {
    providerService.mute();
  }
};

const syncTargetProvider = (state: RootState) => {
  const targetProviderId = selectTargetProviderId(state);

  if (targetProviderId) {
    const config = selectProviderConfig(state, targetProviderId);
    void providerService.switchProvider(targetProviderId, config);
  } else {
    providerService.deactivate();
  }
};

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
      syncTargetProvider(store.getState());
    }

    // After rehydration, attempt to enter target state
    if (rememberRehydrated.match(action)) {
      const state = store.getState();
      syncMicState(state);
      syncTargetProvider(store.getState());
    }

    if (appModeChange.match(action)) {
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
