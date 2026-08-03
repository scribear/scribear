import { configureStore } from '@reduxjs/toolkit';
import { rememberEnhancer, rememberReducer } from 'redux-remember';

import { appLayoutPreferencesReducer } from '@scribear/app-layout-store';
import {
  TranslationService,
  createLiveTranslationMiddleware,
  liveTranslationPreferencesReducer,
  liveTranslationServiceReducer,
} from '@scribear/live-translation-store';
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

import { createKioskMiddleware } from '#src/features/kiosk-provider/stores/kiosk-middleware';
import { kioskReducer } from '#src/features/kiosk-provider/stores/kiosk-slice';
import { splitScreenPreferencesReducer } from '#src/features/kiosk-split-screen/stores/split-screen-preferences-slice';
import { urlConfigSchemas } from '#src/features/url-config/schemas/url-config-schemas';

/**
 * Redux reducers map for the kiosk webapp store. The kiosk slice itself has
 * no persisted state - the only persisted credential is the `DEVICE_TOKEN`
 * cookie, which is HTTP-only and managed by the browser - but display/UI
 * preference slices remain persisted via redux-remember.
 */
const reducers = {
  reduxRemember: reduxRememberReducer,
  urlConfig: urlConfigReducer,
  appLayoutPreferences: appLayoutPreferencesReducer,
  themePreferences: themePreferencesReducer,
  transcriptionContent: transcriptionContentReducer,
  transcriptionDisplayPreferences: transcriptionDisplayPreferencesReducer,
  microphonePreferences: microphonePreferencesReducer,
  microphoneService: microphoneServiceReducer,
  kiosk: kioskReducer,
  splitScreenPreferences: splitScreenPreferencesReducer,
  liveTranslationPreferences: liveTranslationPreferencesReducer,
  liveTranslationService: liveTranslationServiceReducer,
};

// Slice keys that are persisted to `localStorage` via redux-remember. The
// kiosk slice is intentionally absent: per spec, all kiosk runtime state is
// rebuilt from API responses on page load.
export const rememberedKeys: (keyof typeof reducers)[] = [
  'appLayoutPreferences',
  'microphonePreferences',
  'splitScreenPreferences',
  'themePreferences',
  'transcriptionDisplayPreferences',
  // Only the user's intent persists. `liveTranslationService` is absent
  // because model availability and translator liveness are properties of this
  // browser right now and must be re-derived on load.
  'liveTranslationPreferences',
];

// Combined root reducer with redux-remember support.
export const rootReducer = rememberReducer(reducers);

// Creates and returns the configured Redux store for the kiosk webapp.
export const createAppStore = (microphoneService: MicrophoneService) => {
  // Safe to construct on any browser: it probes for the Translator API and
  // reports itself unsupported when absent, which keeps the translation UI off
  // screen everywhere except Chromium desktop.
  const translationService = new TranslationService();

  const store = configureStore({
    reducer: rootReducer,
    middleware: (getDefaultMiddleware) =>
      getDefaultMiddleware()
        .concat(createUrlConfigMiddleware(urlConfigSchemas))
        .concat(createMicrophoneServiceMiddleware(microphoneService))
        .concat(createKioskMiddleware(microphoneService))
        .concat(createLiveTranslationMiddleware(translationService)),
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

// TypeScript type of the full Redux state tree for the kiosk webapp.
export type RootState = ReturnType<typeof rootReducer>;
// TypeScript type of the store's `dispatch` function, including thunk support.
export type AppDispatch = ReturnType<typeof createAppStore>['dispatch'];
// TypeScript type of the configured Redux store instance.
export type AppStore = ReturnType<typeof createAppStore>;
