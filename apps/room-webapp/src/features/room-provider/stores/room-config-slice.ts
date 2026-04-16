import { createSlice } from '@reduxjs/toolkit';

const roomConfigSlice = createSlice({
  name: 'roomConfig',
  initialState: {} as {
    deviceName: string | null;
    deviceId: string | null;
    activeSessionId: string | null;
    prevEventId: number | null;
    sessionRefreshToken: string | null;
  },
  reducers: {},
});

export const roomConfigReducer = roomConfigSlice.reducer;
