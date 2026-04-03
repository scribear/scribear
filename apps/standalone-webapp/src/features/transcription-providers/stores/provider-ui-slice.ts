/**
 * Redux slice for transient provider UI state.
 * This slice is NOT persisted to local storage.
 */
import { type PayloadAction, createSlice } from '@reduxjs/toolkit';

import type { RootState } from '#src/store/store';

import { ProviderId } from '../services/providers/provider-registry';

export interface ProviderUIState {
  /** True while the provider service is lazy-loading a provider module. */
  isLoadingProvider: boolean;
  /** The provider whose config menu is currently open, or null if none. */
  configMenuProviderId: ProviderId | null;
}

const initialState: ProviderUIState = {
  isLoadingProvider: false,
  configMenuProviderId: null,
};

export const selectIsLoadingProvider = (state: RootState) =>
  state.providerUI.isLoadingProvider;

export const selectConfigMenuProviderId = (state: RootState) =>
  state.providerUI.configMenuProviderId;

export const providerUISlice = createSlice({
  name: 'providerUI',
  initialState,
  reducers: {
    setIsLoadingProvider: (state, action: PayloadAction<boolean>) => {
      state.isLoadingProvider = action.payload;
    },
    openConfigMenu: (state, action: PayloadAction<ProviderId>) => {
      state.configMenuProviderId = action.payload;
    },
    closeConfigMenu: (state) => {
      state.configMenuProviderId = null;
    },
  },
});

export const providerUIReducer = providerUISlice.reducer;

export const { setIsLoadingProvider, openConfigMenu, closeConfigMenu } =
  providerUISlice.actions;
