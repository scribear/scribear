import { type PayloadAction, createSlice } from '@reduxjs/toolkit';

import type { RootState } from '#src/store/store';

export interface DisplaySettingsState {
  fontSize: number;
  showJoinCode: boolean;
}

const initialState: DisplaySettingsState = {
  fontSize: 24,
  showJoinCode: false,
};

export const selectFontSize = (state: RootState) => state.displaySettings.fontSize;
export const selectShowJoinCode = (state: RootState) => state.displaySettings.showJoinCode;

const displaySettingsSlice = createSlice({
  name: 'displaySettings',
  initialState,
  reducers: {
    setFontSize: (state, action: PayloadAction<number>) => {
      state.fontSize = action.payload;
    },
    setShowJoinCode: (state, action: PayloadAction<boolean>) => {
      state.showJoinCode = action.payload;
    },
  },
});

export const displaySettingsReducer = displaySettingsSlice.reducer;
export const { setFontSize, setShowJoinCode } = displaySettingsSlice.actions;
