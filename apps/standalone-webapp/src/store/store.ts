import { configureStore } from '@reduxjs/toolkit';
import { rememberEnhancer, rememberReducer } from 'redux-remember';

import { appLayoutPreferencesReducer } from '@scribear/app-layout-store';
import {
  createMicrophoneServiceMiddleware,
  microphonePreferencesReducer,
  microphoneServiceReducer,
} from '@scribear/microphone-store';
import {
  appInitialization,
  reduxRememberReducer,
} from '@scribear/redux-remember-store';
import { themePreferencesReducer } from '@scribear/theme-customization-store';
import { transcriptionContentReducer } from '@scribear/transcription-content-store';
import { transcriptionDisplayPreferencesReducer } from '@scribear/transcription-display-store';

import { appMicrophoneService } from '#src/app-microphone-service';
import { providerConfigReducer } from '#src/features/transcription-providers/stores/provider-config-slice';
import { providerPreferencesReducer } from '#src/features/transcription-providers/stores/provider-preferences-slice';
import { providerServiceMiddleware } from '#src/features/transcription-providers/stores/provider-service-middleware';
import { providerStatusReducer } from '#src/features/transcription-providers/stores/provider-status-slice';
import { createUrlFragmentDriver } from '#src/features/url-config/url-fragment-driver';

// All Redux slice reducers combined into the root reducer map.
const reducers = {
  reduxRemember: reduxRememberReducer,
  appLayoutPreferences: appLayoutPreferencesReducer,
  themePreferences: themePreferencesReducer,
  transcriptionContent: transcriptionContentReducer,
  transcriptionDisplayPreferences: transcriptionDisplayPreferencesReducer,
  microphonePreferences: microphonePreferencesReducer,
  microphoneService: microphoneServiceReducer,
  providerConfig: providerConfigReducer,
  providerPreferences: providerPreferencesReducer,
  providerStatus: providerStatusReducer,
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

// Slice keys whose state can be overridden via a URL fragment config.
export const urlConfigurableKeys: (keyof typeof reducers)[] = [
  'appLayoutPreferences',
  'microphonePreferences',
  'themePreferences',
  'transcriptionDisplayPreferences',
  'providerConfig',
  'providerPreferences',
];

const urlFragmentDriver = createUrlFragmentDriver(
  reducers,
  urlConfigurableKeys,
);

// Root reducer wrapping all slices with redux-remember persistence support.
export const rootReducer = rememberReducer(reducers);

// Configured Redux store for the standalone webapp.
export const store = configureStore({
  reducer: rootReducer,
  middleware: (getDefaultMiddleware) =>
    getDefaultMiddleware()
      .concat(createMicrophoneServiceMiddleware(appMicrophoneService))
      .concat(providerServiceMiddleware),
  enhancers: (getDefaultEnhancers) =>
    getDefaultEnhancers().prepend(
      rememberEnhancer(urlFragmentDriver, rememberedKeys, {
        initActionType: appInitialization.type,
      }),
    ),
});

// TypeScript type of the full Redux state tree.
export type RootState = ReturnType<typeof rootReducer>;
// TypeScript type of the store's dispatch function.
export type AppDispatch = typeof store.dispatch;
// TypeScript type of the Redux store instance.
export type AppStore = typeof store;

store.dispatch(appInitialization());
