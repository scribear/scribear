/**
 * Redux slice for storing user transcription provider preference
 * This slice is saved to local storage
 */
import { type PayloadAction, createSlice } from '@reduxjs/toolkit';

import type { RootState } from '#src/store/store';

import {
  ProviderId,
  type ProviderStatusTypeMap,
  getInitialStatusState,
} from '../services/providers/provider-registry';

// Shape of the `providerStatus` Redux slice - one runtime status per provider.
export type ProviderStatusSlice = ProviderStatusTypeMap;

const initialState: ProviderStatusSlice = getInitialStatusState();

/**
 * Selects the current runtime status for a given provider.
 *
 * @param state - The full Redux root state.
 * @param providerId - The provider whose status to retrieve.
 * @returns The typed status for that provider.
 */
export const selectProviderStatus = <K extends ProviderId>(
  state: RootState,
  providerId: K,
): ProviderStatusTypeMap[K] => state.providerStatus[providerId];

// Discriminated-union payload for the `setProviderStatus` action.
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
// Reducer for the `providerStatus` slice.
export const providerStatusReducer = providerStatusSlice.reducer;

// Action creator that replaces the stored status for a specific provider.
export const { setProviderStatus } = providerStatusSlice.actions;
