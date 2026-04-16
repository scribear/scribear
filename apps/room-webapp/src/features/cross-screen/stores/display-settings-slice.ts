import { createSlice } from '@reduxjs/toolkit';

const displaySettingsSlice = createSlice({
  name: 'displaySettings',
  initialState: {
    fontSize: 24,
    showJoinCode: false,
  },
  reducers: {},
});

export const displaySettingsReducer = displaySettingsSlice.reducer;
