import { configureStore } from '@reduxjs/toolkit';
import { rememberEnhancer, rememberReducer } from 'redux-remember';

import { appLayoutPreferencesReducer } from '@scribear/app-layout-store';
import {
  createMicrophoneServiceMiddleware,
  microphonePreferencesReducer,
  microphoneServiceReducer,
} from '@scribear/microphone-store';
import type { MicrophoneService } from '@scribear/microphone-store';
import {
  appInitialization,
  reduxRememberReducer,
} from '@scribear/redux-remember-store';
import { themePreferencesReducer } from '@scribear/theme-customization-store';
import { transcriptionContentReducer } from '@scribear/transcription-content-store';
import { transcriptionDisplayPreferencesReducer } from '@scribear/transcription-display-store';
import {
  createUrlConfigMiddleware,
  urlConfigReducer,
} from '@scribear/url-config-store';

import { providerConfigReducer } from '#src/features/transcription-providers/stores/provider-config-slice';
import { providerPreferencesReducer } from '#src/features/transcription-providers/stores/provider-preferences-slice';
import { createProviderServiceMiddleware } from '#src/features/transcription-providers/stores/provider-service-middleware';
import { providerStatusReducer } from '#src/features/transcription-providers/stores/provider-status-slice';
import { providerUIReducer } from '#src/features/transcription-providers/stores/provider-ui-slice';
import { urlConfigSchemas } from '#src/features/url-config/schemas/url-config-schemas';

// All Redux slice reducers combined into the root reducer map.
const reducers = {
  reduxRemember: reduxRememberReducer,
  urlConfig: urlConfigReducer,
  appLayoutPreferences: appLayoutPreferencesReducer,
  themePreferences: themePreferencesReducer,
  transcriptionContent: transcriptionContentReducer,
  transcriptionDisplayPreferences: transcriptionDisplayPreferencesReducer,
  microphonePreferences: microphonePreferencesReducer,
  microphoneService: microphoneServiceReducer,
  providerConfig: providerConfigReducer,
  providerPreferences: providerPreferencesReducer,
  providerStatus: providerStatusReducer,
  providerUI: providerUIReducer,
};

// Slice keys that are persisted to localStorage via redux-remember.
export const rememberedKeys: (keyof typeof reducers)[] = [
  'appLayoutPreferences',
  'microphonePreferences',
  'themePreferences',
  'transcriptionDisplayPreferences',
  'providerConfig',
  'providerPreferences',
];

// Root reducer wrapping all slices with redux-remember persistence support.
export const rootReducer = rememberReducer(reducers);

// Creates and returns the configured Redux store for the standalone webapp.
export const createAppStore = (microphoneService: MicrophoneService) => {
  const store = configureStore({
    reducer: rootReducer,
    middleware: (getDefaultMiddleware) =>
      getDefaultMiddleware()
        .concat(createUrlConfigMiddleware(urlConfigSchemas))
        .concat(createMicrophoneServiceMiddleware(microphoneService))
        .concat(createProviderServiceMiddleware(microphoneService)),
    enhancers: (getDefaultEnhancers) =>
      getDefaultEnhancers().prepend(
        rememberEnhancer(window.localStorage, rememberedKeys, {
          initActionType: appInitialization.type,
        }),
      ),
  });

  store.dispatch(appInitialization());

  return store;
};

// TypeScript type of the full Redux state tree.
export type RootState = ReturnType<typeof rootReducer>;
// TypeScript type of the store's dispatch function.
export type AppDispatch = ReturnType<typeof createAppStore>['dispatch'];
// TypeScript type of the Redux store instance.
export type AppStore = ReturnType<typeof createAppStore>;
