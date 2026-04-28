import { configureStore } from '@reduxjs/toolkit';
import { rememberEnhancer, rememberReducer } from 'redux-remember';

import { appLayoutPreferencesReducer } from '@scribear/app-layout-store';
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

import { clientSessionConfigReducer } from '#src/features/session-provider/stores/client-session-config-slice';
import { createClientSessionServiceMiddleware } from '#src/features/session-provider/stores/client-session-service-middleware';
import { clientSessionServiceReducer } from '#src/features/session-provider/stores/client-session-service-slice';
import { urlConfigSchemas } from '#src/features/url-config/schemas/url-config-schemas';

/**
 * Redux reducers map for the client webapp store. Includes slices for app layout,
 * theme preferences, transcription content, transcription display preferences,
 * client session configuration and service state, and redux-remember rehydration
 * bookkeeping.
 */
const reducers = {
  reduxRemember: reduxRememberReducer,
  urlConfig: urlConfigReducer,
  appLayoutPreferences: appLayoutPreferencesReducer,
  themePreferences: themePreferencesReducer,
  transcriptionContent: transcriptionContentReducer,
  transcriptionDisplayPreferences: transcriptionDisplayPreferencesReducer,
  clientSessionConfig: clientSessionConfigReducer,
  clientSessionService: clientSessionServiceReducer,
};

// Slice keys that are persisted to `localStorage` via redux-remember.
export const rememberedKeys: (keyof typeof reducers)[] = [
  'appLayoutPreferences',
  'themePreferences',
  'transcriptionDisplayPreferences',
  'clientSessionConfig',
];

// Combined root reducer with redux-remember support.
export const rootReducer = rememberReducer(reducers);

// Creates and returns the configured Redux store for the client webapp.
export const createAppStore = () => {
  const store = configureStore({
    reducer: rootReducer,
    middleware: (getDefaultMiddleware) =>
      getDefaultMiddleware()
        .concat(createUrlConfigMiddleware(urlConfigSchemas))
        .concat(createClientSessionServiceMiddleware()),
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

// TypeScript type of the full Redux state tree for the client webapp.
export type RootState = ReturnType<typeof rootReducer>;
// TypeScript type of the store's `dispatch` function, including thunk support.
export type AppDispatch = ReturnType<typeof createAppStore>['dispatch'];
// TypeScript type of the configured Redux store instance.
export type AppStore = ReturnType<typeof createAppStore>;
