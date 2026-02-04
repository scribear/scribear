/**
 * Redux slice for handling redux remember rehydration
 */
import { createAction, createSlice } from '@reduxjs/toolkit';
import { REMEMBER_REHYDRATED } from 'redux-remember';

import type { RootState } from '@/stores/store';

export interface ReduxRememberSlice {
  isRehydrated: boolean;
}

const initialState: ReduxRememberSlice = {
  isRehydrated: false,
};

// Selectors
export const selectIsRehydrated = (state: RootState) =>
  state.reduxRemember.isRehydrated;

// Actions
export const rememberRehydrated = createAction(REMEMBER_REHYDRATED);

const reduxRemember = createSlice({
  name: 'reduxRemember',
  initialState,
  reducers: {},
  extraReducers: (builder) =>
    builder.addCase(rememberRehydrated, (state) => {
      state.isRehydrated = true;
    }),
});
export const reduxRememberReducer = reduxRemember.reducer;
