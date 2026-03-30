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

/**
 * Redux reducers map for the client webapp store. Includes slices for app layout,
 * theme preferences, transcription content, transcription display preferences,
 * and redux-remember rehydration bookkeeping.
 */
const reducers = {
  reduxRemember: reduxRememberReducer,
  appLayoutPreferences: appLayoutPreferencesReducer,
  themePreferences: themePreferencesReducer,
  transcriptionContent: transcriptionContentReducer,
  transcriptionDisplayPreferences: transcriptionDisplayPreferencesReducer,
};

// Slice keys that are persisted to `localStorage` via redux-remember.
export const rememberedKeys: (keyof typeof reducers)[] = [
  'appLayoutPreferences',
  'themePreferences',
  'transcriptionDisplayPreferences',
];

// Combined root reducer with redux-remember support.
export const rootReducer = rememberReducer(reducers);

// Configured Redux store with localStorage persistence via redux-remember.
export const store = configureStore({
  reducer: rootReducer,
  enhancers: (getDefaultEnhancers) =>
    getDefaultEnhancers().prepend(
      rememberEnhancer(window.localStorage, rememberedKeys, {
        initActionType: appInitialization.type,
      }),
    ),
});

// TypeScript type of the full Redux state tree for the client webapp.
export type RootState = ReturnType<typeof rootReducer>;
// TypeScript type of the store's `dispatch` function, including thunk support.
export type AppDispatch = typeof store.dispatch;
// TypeScript type of the configured Redux store instance.
export type AppStore = typeof store;

store.dispatch(appInitialization());
