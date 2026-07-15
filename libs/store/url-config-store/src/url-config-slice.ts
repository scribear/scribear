import { type PayloadAction, createSlice } from '@reduxjs/toolkit';

/**
 * State shape for the url-config slice, which stores validation errors
 * from a URL fragment config attempt.
 */
export interface UrlConfigSlice {
  errors: string[] | null;
}

interface WithUrlConfig {
  urlConfig: UrlConfigSlice;
}

const initialState: UrlConfigSlice = {
  errors: null,
};

/**
 * Selects the URL config validation errors, or null if there were none.
 * @param state - The Redux state containing the urlConfig slice.
 */
export const selectUrlConfigErrors = (state: WithUrlConfig) =>
  state.urlConfig.errors;

/**
 * Redux slice for storing URL fragment config validation errors so they
 * can be displayed in a modal.
 */
export const urlConfigSlice = createSlice({
  name: 'urlConfig',
  initialState,
  reducers: {
    /**
     * Sets the URL config validation errors to display.
     */
    setUrlConfigErrors: (state, action: PayloadAction<string[]>) => {
      state.errors = action.payload;
    },
    /**
     * Clears the URL config validation errors (e.g. when the user dismisses the modal).
     */
    clearUrlConfigErrors: (state) => {
      state.errors = null;
    },
  },
});

// Reducer for the urlConfig slice.
export const urlConfigReducer = urlConfigSlice.reducer;

export const { setUrlConfigErrors, clearUrlConfigErrors } =
  urlConfigSlice.actions;
