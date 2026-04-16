import { createSlice } from '@reduxjs/toolkit';

interface RoomConfigState {
  deviceName: string | null;
  deviceId: string | null;
  activeSessionId: string | null;
  prevEventId: number;
  sessionRefreshToken: string | null;
}

const initialState: RoomConfigState = {
  deviceName: null,
  deviceId: null,
  activeSessionId: null,
  prevEventId: -1,
  sessionRefreshToken: null,
};

const roomConfigSlice = createSlice({
  name: 'roomConfig',
  initialState,
  reducers: {},
});

export const roomConfigReducer = roomConfigSlice.reducer;
export type { RoomConfigState };
