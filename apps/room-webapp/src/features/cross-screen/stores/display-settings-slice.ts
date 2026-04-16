import { createSlice } from '@reduxjs/toolkit';

interface DisplaySettingsState {
  fontSize: number;
  showJoinCode: boolean;
}

const initialState: DisplaySettingsState = {
  fontSize: 24,
  showJoinCode: false,
};

const displaySettingsSlice = createSlice({
  name: 'displaySettings',
  initialState,
  reducers: {},
});

export const displaySettingsReducer = displaySettingsSlice.reducer;
export type { DisplaySettingsState };
