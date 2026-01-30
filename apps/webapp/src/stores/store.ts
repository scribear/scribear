/**
 * Defines and creates application redux store
 */
import { configureStore, createAction } from '@reduxjs/toolkit';
import { rememberEnhancer, rememberReducer } from 'redux-remember';

import { appModeReducer } from '../core/app-mode/store/app-mode-slice';
import { reduxRememberReducer } from './slices/redux-remember-slice';

const reducers = {
  appMode: appModeReducer,
  reduxRemember: reduxRememberReducer,
};

// Keys to save to local storage
export const rememberedKeys: (keyof typeof reducers)[] = [];

export const rootReducer = rememberReducer(reducers);

export const appInitialization = createAction('APP_INITIALIZATION');

export const store = configureStore({
  reducer: rootReducer,
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
