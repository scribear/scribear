/**
 * Redux slice for storing user transcription provider preference
 * This slice is saved to local storage
 */
import { type PayloadAction, createSlice } from '@reduxjs/toolkit';

import type { RootState } from '@/stores/store';

import {
  type ProviderConfigTypeMap,
  ProviderId,
  getInitialConfigState,
} from '../services/providers/provider-registry';

export type ProviderConfigSlice = ProviderConfigTypeMap;

const initialState: ProviderConfigSlice = getInitialConfigState();

// Selectors
export const selectProviderConfig = <K extends ProviderId>(
  state: RootState,
  providerId: K,
): ProviderConfigTypeMap[K] => state.providerConfig[providerId];

type UpdateProviderConfigPayload = {
  [K in ProviderId]: {
    providerId: K;
    newConfig: Partial<ProviderConfigTypeMap[K]>;
  };
}[ProviderId];

export const providerConfigSlice = createSlice({
  name: 'providerConfig',
  initialState,
  reducers: {
    updateProviderConfig: (
      state,
      action: PayloadAction<UpdateProviderConfigPayload>,
    ) => {
      const { providerId, newConfig } = action.payload;
      state[providerId] = { ...state[providerId], ...newConfig } as never;
    },
  },
});
export const providerConfigReducer = providerConfigSlice.reducer;

// Action Creators
export const { updateProviderConfig } = providerConfigSlice.actions;
