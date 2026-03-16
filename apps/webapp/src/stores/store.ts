/**
 * Defines and creates application redux store
 */
import { configureStore, createAction } from '@reduxjs/toolkit';
import { rememberEnhancer, rememberReducer } from 'redux-remember';

import { microphonePreferencesReducer } from '#src/core/microphone/stores/microphone-preferences-slice';
import { microphoneServiceMiddleware } from '#src/core/microphone/stores/microphone-service-middleware';
import { microphoneServiceReducer } from '#src/core/microphone/stores/microphone-service-slice';
import { transcriptionContentReducer } from '#src/core/transcription-content/store/transcription-content-slice';
import { themePreferencesReducer } from '#src/features/theme-customization/stores/theme-preferences-slice';
import { transcriptionDisplayPreferencesReducer } from '#src/features/transcription-display/stores/transcription-display-preferences-slice';
import { providerConfigReducer } from '#src/features/transcription-providers/stores/provider-config-slice';
import { providerPreferencesReducer } from '#src/features/transcription-providers/stores/provider-preferences-slice';
import { providerServiceMiddleware } from '#src/features/transcription-providers/stores/provider-service-middleware';
import { providerStatusReducer } from '#src/features/transcription-providers/stores/provider-status-slice';

import { appModeReducer } from '../core/app-mode/store/app-mode-slice';
import { appLayoutPreferencesReducer } from './slices/app-layout-preferences-slice';
import { reduxRememberReducer } from './slices/redux-remember-slice';

const reducers = {
  appLayoutPreferences: appLayoutPreferencesReducer,
  appMode: appModeReducer,
  reduxRemember: reduxRememberReducer,

  microphonePreferences: microphonePreferencesReducer,
  microphoneService: microphoneServiceReducer,

  transcriptionContent: transcriptionContentReducer,

  themePreferences: themePreferencesReducer,

  transcriptionDisplayPreferences: transcriptionDisplayPreferencesReducer,

  providerConfig: providerConfigReducer,
  providerPreferences: providerPreferencesReducer,
  providerStatus: providerStatusReducer,
};

// Keys to save to local storage
export const rememberedKeys: (keyof typeof reducers)[] = [
  'appLayoutPreferences',
  'microphonePreferences',
  'themePreferences',
  'transcriptionDisplayPreferences',
  'providerConfig',
  'providerPreferences',
];

export const rootReducer = rememberReducer(reducers);

export const appInitialization = createAction('APP_INITIALIZATION');

export const store = configureStore({
  reducer: rootReducer,
  middleware: (getDefaultMiddleware) =>
    getDefaultMiddleware()
      .concat(microphoneServiceMiddleware)
      .concat(providerServiceMiddleware),
  enhancers: (getDefaultEnhancers) =>
    getDefaultEnhancers().prepend(
      rememberEnhancer(window.localStorage, rememberedKeys, {
        initActionType: appInitialization.type,
      }),
    ),
});

export type RootState = ReturnType<typeof rootReducer>;
export type AppDispatch = typeof store.dispatch;
export type AppStore = typeof store;

store.dispatch(appInitialization());
