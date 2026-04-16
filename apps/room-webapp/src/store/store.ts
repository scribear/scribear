import { configureStore } from '@reduxjs/toolkit';
import { rememberEnhancer, rememberReducer } from 'redux-remember';

import { appLayoutPreferencesReducer } from '@scribear/app-layout-store';
import {
  createMicrophoneServiceMiddleware,
  microphonePreferencesReducer,
  microphoneServiceReducer,
  type MicrophoneService,
} from '@scribear/microphone-store';
import {
  appInitialization,
  reduxRememberReducer,
} from '@scribear/redux-remember-store';
import { themePreferencesReducer } from '@scribear/theme-customization-store';
import { transcriptionContentReducer } from '@scribear/transcription-content-store';
import { transcriptionDisplayPreferencesReducer } from '@scribear/transcription-display-store';

import { createCrossScreenMiddleware } from '#src/features/cross-screen/stores/cross-screen-middleware';
import { displaySettingsReducer } from '#src/features/cross-screen/stores/display-settings-slice';
import { roomConfigReducer } from '#src/features/room-provider/stores/room-config-slice';
import { createRoomServiceMiddleware } from '#src/features/room-provider/stores/room-service-middleware';
import { roomServiceReducer } from '#src/features/room-provider/stores/room-service-slice';

/**
 * Redux reducers map for the room webapp store. Includes slices for app layout,
 * theme preferences, transcription content, transcription display preferences,
 * microphone preferences and service state, room configuration and service state,
 * display settings, and redux-remember rehydration bookkeeping.
 */
const reducers = {
  reduxRemember: reduxRememberReducer,
  appLayoutPreferences: appLayoutPreferencesReducer,
  themePreferences: themePreferencesReducer,
  transcriptionContent: transcriptionContentReducer,
  transcriptionDisplayPreferences: transcriptionDisplayPreferencesReducer,
  microphonePreferences: microphonePreferencesReducer,
  microphoneService: microphoneServiceReducer,
  roomConfig: roomConfigReducer,
  roomService: roomServiceReducer,
  displaySettings: displaySettingsReducer,
};

// Slice keys that are persisted to `localStorage` via redux-remember.
export const rememberedKeys: (keyof typeof reducers)[] = [
  'appLayoutPreferences',
  'microphonePreferences',
  'themePreferences',
  'transcriptionDisplayPreferences',
  'roomConfig',
  'displaySettings',
];

// Combined root reducer with redux-remember support.
export const rootReducer = rememberReducer(reducers);

// Creates and returns the configured Redux store for the room webapp.
export const createAppStore = (microphoneService: MicrophoneService) => {
  const store = configureStore({
    reducer: rootReducer,
    middleware: (getDefaultMiddleware) =>
      getDefaultMiddleware()
        .concat(createMicrophoneServiceMiddleware(microphoneService))
        .concat(createRoomServiceMiddleware(microphoneService))
        .concat(createCrossScreenMiddleware()),
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

// TypeScript type of the full Redux state tree for the room webapp.
export type RootState = ReturnType<typeof rootReducer>;
// TypeScript type of the store's `dispatch` function, including thunk support.
export type AppDispatch = ReturnType<typeof createAppStore>['dispatch'];
// TypeScript type of the configured Redux store instance.
export type AppStore = ReturnType<typeof createAppStore>;
