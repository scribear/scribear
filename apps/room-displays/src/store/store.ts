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

import { createBroadcastChannelMiddleware } from '#src/features/broadcast-channel/stores/broadcast-channel-middleware';
import { splitScreenPreferencesReducer } from '#src/features/kiosk-split-screen/stores/split-screen-preferences-slice';
import { kioskConfigReducer } from '#src/features/kiosk-provider/stores/kiosk-config-slice';
import { createKioskServiceMiddleware } from '#src/features/kiosk-provider/stores/kiosk-service-middleware';
import { kioskServiceReducer } from '#src/features/kiosk-provider/stores/kiosk-service-slice';
import { sessionControlsReducer } from '#src/features/session-controls/stores/session-controls-slice';
import { urlConfigSchemas } from '#src/features/url-config/schemas/url-config-schemas';

const reducers = {
  reduxRemember: reduxRememberReducer,
  urlConfig: urlConfigReducer,
  appLayoutPreferences: appLayoutPreferencesReducer,
  themePreferences: themePreferencesReducer,
  transcriptionContent: transcriptionContentReducer,
  transcriptionDisplayPreferences: transcriptionDisplayPreferencesReducer,
  microphonePreferences: microphonePreferencesReducer,
  microphoneService: microphoneServiceReducer,
  kioskConfig: kioskConfigReducer,
  kioskService: kioskServiceReducer,
  sessionControls: sessionControlsReducer,
  splitScreenPreferences: splitScreenPreferencesReducer,
};

export const rememberedKeys: (keyof typeof reducers)[] = [
  'appLayoutPreferences',
  'microphonePreferences',
  'splitScreenPreferences',
  'themePreferences',
  'transcriptionDisplayPreferences',
  'kioskConfig',
];

export const rootReducer = rememberReducer(reducers);

interface CreateStoreOptions {
  microphoneService: MicrophoneService;
  role: 'host' | 'display';
}

export const createAppStore = ({
  microphoneService,
  role,
}: CreateStoreOptions) => {
  const store = configureStore({
    reducer: rootReducer,
    middleware: (getDefaultMiddleware) =>
      role === 'host'
        ? getDefaultMiddleware()
            .concat(createUrlConfigMiddleware(urlConfigSchemas))
            .concat(createBroadcastChannelMiddleware({ role }))
            .concat(createMicrophoneServiceMiddleware(microphoneService))
            .concat(createKioskServiceMiddleware(microphoneService))
        : getDefaultMiddleware()
            .concat(createUrlConfigMiddleware(urlConfigSchemas))
            .concat(createBroadcastChannelMiddleware({ role })),
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

export type RootState = ReturnType<typeof rootReducer>;
export type AppDispatch = ReturnType<typeof createAppStore>['dispatch'];
export type AppStore = ReturnType<typeof createAppStore>;
