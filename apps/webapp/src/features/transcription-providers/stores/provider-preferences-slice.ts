/**
 * Redux slice for storing user transcription provider preference
 * This slice is saved to local storage
 */
import {
  type PayloadAction,
  createSelector,
  createSlice,
} from '@reduxjs/toolkit';

import { selectAppMode } from '@/core/app-mode/store/app-mode-slice';
import type { RootState } from '@/stores/store';
import { AppMode } from '@/types/app-mode';

import { ProviderId } from '../services/providers/provider-registry';

export interface TranscriptionProviderPreferencesSlice {
  preferredProviderId: ProviderId | null;
}

const initialState: TranscriptionProviderPreferencesSlice = {
  preferredProviderId: null,
};

// Selectors
export const selectPreferredProviderId = (state: RootState) =>
  state.providerPreferences.preferredProviderId;
export const selectTargetProviderId = createSelector(
  [selectAppMode, selectPreferredProviderId],
  (appMode, preferredProviderId) => {
    if (appMode === AppMode.STANDALONE) return preferredProviderId;

    return ProviderId.WEBSPEECH;
  },
);

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
export const providerPreferencesReducer = providerPreferencesSlice.reducer;

// Action Creators
export const { setPreferredProviderId } = providerPreferencesSlice.actions;
