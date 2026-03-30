/**
 * Redux slice for storing user transcription provider preference
 * This slice is saved to local storage
 */
import { type PayloadAction, createSlice } from '@reduxjs/toolkit';

import type { RootState } from '#src/store/store';

import { ProviderId } from '../services/providers/provider-registry';

/**
 * Shape of the `providerPreferences` Redux slice.
 */
export interface TranscriptionProviderPreferencesSlice {
  /**
   * The provider the user has chosen, or `null` if no provider is selected.
   */
  preferredProviderId: ProviderId | null;
}

const initialState: TranscriptionProviderPreferencesSlice = {
  preferredProviderId: null,
};

/**
 * Selects the user's preferred (persisted) provider ID, or `null` if none is set.
 */
export const selectPreferredProviderId = (state: RootState) =>
  state.providerPreferences.preferredProviderId;

/**
 * Alias for {@link selectPreferredProviderId}. Represents the provider the
 * service layer should activate.
 */
export const selectTargetProviderId = selectPreferredProviderId;

export const providerPreferencesSlice = createSlice({
  name: 'providerPreferences',
  initialState,
  reducers: {
    setPreferredProviderId: (
      state,
      action: PayloadAction<ProviderId | null>,
    ) => {
      state.preferredProviderId = action.payload;
    },
  },
});
// Reducer for the `providerPreferences` slice.
export const providerPreferencesReducer = providerPreferencesSlice.reducer;

// Action creator that sets or clears the user's preferred provider.
export const { setPreferredProviderId } = providerPreferencesSlice.actions;
