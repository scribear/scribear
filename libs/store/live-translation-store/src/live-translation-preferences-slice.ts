import { type PayloadAction, createSlice } from '@reduxjs/toolkit';

import { DEFAULT_TARGET_LANGUAGE } from './config/translation-languages.js';

/**
 * The user's persisted translation choices.
 *
 * Only intent is stored here, never runtime state: whether a model is
 * downloaded, or a translator alive, is a property of this browser at this
 * moment and must not survive a reload.
 */
export interface LiveTranslationPreferencesSlice {
  isTranslationEnabled: boolean;
  targetLanguage: string;
}

interface WithLiveTranslationPreferences {
  liveTranslationPreferences: LiveTranslationPreferencesSlice;
}

const initialState: LiveTranslationPreferencesSlice = {
  // Off by default. Translation costs a model download and produces text no
  // human has checked, so it is opt-in on every device.
  isTranslationEnabled: false,
  targetLanguage: DEFAULT_TARGET_LANGUAGE,
};

/**
 * Selects whether the user has asked for translated captions.
 * @param state - Redux state containing the liveTranslationPreferences slice.
 */
export const selectIsTranslationEnabled = (
  state: WithLiveTranslationPreferences,
) => state.liveTranslationPreferences.isTranslationEnabled;

/**
 * Selects the BCP-47 tag the user wants captions translated into.
 * @param state - Redux state containing the liveTranslationPreferences slice.
 */
export const selectTargetLanguage = (state: WithLiveTranslationPreferences) =>
  state.liveTranslationPreferences.targetLanguage;

/**
 * Redux slice storing the user's translation preferences. The live-translation
 * middleware observes these and drives the {@link TranslationService}.
 */
export const liveTranslationPreferencesSlice = createSlice({
  name: 'liveTranslationPreferences',
  initialState,
  reducers: {
    /**
     * Turns translated captions on, optionally switching target language.
     * Dispatched only after the user has confirmed the gate dialog.
     */
    enableTranslation: (state, action: PayloadAction<string | undefined>) => {
      state.isTranslationEnabled = true;
      if (action.payload !== undefined) state.targetLanguage = action.payload;
    },
    /**
     * Turns translated captions off. Dispatched only after confirmation.
     */
    disableTranslation: (state) => {
      state.isTranslationEnabled = false;
    },
    /**
     * Changes the target language, leaving the on/off preference alone.
     */
    setTargetLanguage: (state, action: PayloadAction<string>) => {
      state.targetLanguage = action.payload;
    },
  },
});

// Reducer for the liveTranslationPreferences slice.
export const liveTranslationPreferencesReducer =
  liveTranslationPreferencesSlice.reducer;

export const { enableTranslation, disableTranslation, setTargetLanguage } =
  liveTranslationPreferencesSlice.actions;
