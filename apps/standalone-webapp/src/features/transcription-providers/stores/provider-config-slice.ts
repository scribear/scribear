/**
 * Redux slice for storing user transcription provider preference
 * This slice is saved to local storage
 */
import { type PayloadAction, createSlice } from '@reduxjs/toolkit';

import type { RootState } from '#src/store/store';

import {
  type ProviderConfigTypeMap,
  ProviderId,
  providerRegistry,
} from '../services/providers/provider-registry';

// Shape of the `providerConfig` Redux slice - one config entry per provider.
export type ProviderConfigSlice = ProviderConfigTypeMap;

const initialState: ProviderConfigSlice = Object.fromEntries(
  Object.values(ProviderId).map((id) => [
    id,
    providerRegistry[id].initialConfig,
  ]),
) as unknown as ProviderConfigTypeMap;

/**
 * Selects the persisted configuration object for a given provider.
 *
 * @param state - The full Redux root state.
 * @param providerId - The provider whose config to retrieve.
 * @returns The typed config for that provider.
 */
export const selectProviderConfig = <K extends ProviderId>(
  state: RootState,
  providerId: K,
): ProviderConfigTypeMap[K] => state.providerConfig[providerId];

// Discriminated-union payload for the `updateProviderConfig` action.
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
// Reducer for the `providerConfig` slice.
export const providerConfigReducer = providerConfigSlice.reducer;

// Action creator that merges a partial config update into the stored config for a specific provider.
export const { updateProviderConfig } = providerConfigSlice.actions;
