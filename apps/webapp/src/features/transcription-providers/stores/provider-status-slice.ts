/**
 * Redux slice for storing user transcription provider preference
 * This slice is saved to local storage
 */
import { type PayloadAction, createSlice } from '@reduxjs/toolkit';

import type { RootState } from '@/stores/store';

import {
  ProviderId,
  type ProviderStatusTypeMap,
  getInitialStatusState,
} from '../services/providers/provider-registry';

export type ProviderStatusSlice = ProviderStatusTypeMap;

const initialState: ProviderStatusSlice = getInitialStatusState();

// Selectors
export const selectProviderStatus = <K extends ProviderId>(
  state: RootState,
  providerId: K,
): ProviderStatusTypeMap[K] => state.providerStatus[providerId];

export type SetProviderStatusPayload = {
  [K in ProviderId]: {
    providerId: K;
    newStatus: ProviderStatusTypeMap[K];
  };
}[ProviderId];

export const providerStatusSlice = createSlice({
  name: 'providerStatus',
  initialState,
  reducers: {
    setProviderStatus: (
      state,
      action: PayloadAction<SetProviderStatusPayload>,
    ) => {
      const { providerId, newStatus } = action.payload;
      state[providerId] = newStatus as never;
    },
  },
});
export const providerStatusReducer = providerStatusSlice.reducer;

// Action Creators
export const { setProviderStatus } = providerStatusSlice.actions;
