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
import { kioskConfigReducer } from '#src/features/kiosk-provider/stores/kiosk-config-slice';
import { createKioskServiceMiddleware } from '#src/features/kiosk-provider/stores/kiosk-service-middleware';
import { kioskServiceReducer } from '#src/features/kiosk-provider/stores/kiosk-service-slice';
import { splitScreenPreferencesReducer } from '#src/features/kiosk-split-screen/stores/split-screen-preferences-slice';

/**
 * Redux reducers map for the kiosk webapp store. Includes slices for app layout,
 * theme preferences, transcription content, transcription display preferences,
 * microphone preferences and service state, kiosk configuration and service state,
 * split-screen preferences, and redux-remember rehydration bookkeeping.
 */
const reducers = {
  reduxRemember: reduxRememberReducer,
  appLayoutPreferences: appLayoutPreferencesReducer,
  themePreferences: themePreferencesReducer,
  transcriptionContent: transcriptionContentReducer,
  transcriptionDisplayPreferences: transcriptionDisplayPreferencesReducer,
  microphonePreferences: microphonePreferencesReducer,
  microphoneService: microphoneServiceReducer,
  kioskConfig: kioskConfigReducer,
  kioskService: kioskServiceReducer,
  splitScreenPreferences: splitScreenPreferencesReducer,
};

// Slice keys that are persisted to `localStorage` via redux-remember.
export const rememberedKeys: (keyof typeof reducers)[] = [
  'appLayoutPreferences',
  'microphonePreferences',
  'splitScreenPreferences',
  'themePreferences',
  'transcriptionDisplayPreferences',
  'kioskConfig',
];

// Combined root reducer with redux-remember support.
export const rootReducer = rememberReducer(reducers);

// Configured Redux store with localStorage persistence and kiosk/microphone middleware.
export const store = configureStore({
  reducer: rootReducer,
  middleware: (getDefaultMiddleware) =>
    getDefaultMiddleware()
      .concat(createMicrophoneServiceMiddleware(appMicrophoneService))
      .concat(createKioskServiceMiddleware(appMicrophoneService)),
  enhancers: (getDefaultEnhancers) =>
    getDefaultEnhancers().prepend(
      rememberEnhancer(window.localStorage, rememberedKeys, {
        initActionType: appInitialization.type,
      }),
    ),
});

// TypeScript type of the full Redux state tree for the kiosk webapp.
export type RootState = ReturnType<typeof rootReducer>;
// TypeScript type of the store's `dispatch` function, including thunk support.
export type AppDispatch = typeof store.dispatch;
// TypeScript type of the configured Redux store instance.
export type AppStore = typeof store;

store.dispatch(appInitialization());
