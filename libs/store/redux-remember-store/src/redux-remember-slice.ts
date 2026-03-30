import { createAction, createSlice } from '@reduxjs/toolkit';
import { REMEMBER_REHYDRATED } from 'redux-remember';

/**
 * State shape for the redux-remember slice, which tracks whether persisted
 * state has been rehydrated from storage.
 */
export interface ReduxRememberSlice {
  isRehydrated: boolean;
}

interface WithReduxRemember {
  reduxRemember: ReduxRememberSlice;
}

const initialState: ReduxRememberSlice = {
  isRehydrated: false,
};

/**
 * Selects whether the persisted Redux state has been rehydrated from storage.
 * @param state - The Redux state containing the reduxRemember slice.
 * @returns `true` once redux-remember has finished rehydrating persisted state.
 */
export const selectIsRehydrated = (state: WithReduxRemember) =>
  state.reduxRemember.isRehydrated;

/**
 * Action creator that wraps the redux-remember `REMEMBER_REHYDRATED` action type.
 * Dispatched by redux-remember when persisted state has been restored from storage.
 */
export const rememberRehydrated = createAction(REMEMBER_REHYDRATED);

/**
 * Action dispatched once during application startup to trigger initialization
 * logic that depends on the store being ready (e.g., syncing service state).
 */
export const appInitialization = createAction('APP_INITIALIZATION');

const reduxRememberSlice = createSlice({
  name: 'reduxRemember',
  initialState,
  reducers: {},
  extraReducers: (builder) =>
    builder.addCase(rememberRehydrated, (state) => {
      state.isRehydrated = true;
    }),
});

// Reducer for the reduxRemember slice.
export const reduxRememberReducer = reduxRememberSlice.reducer;
