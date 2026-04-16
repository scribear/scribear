import { createSlice } from '@reduxjs/toolkit';

const roomServiceSlice = createSlice({
  name: 'roomService',
  initialState: {} as {
    roomServiceStatus: string | null;
    sessionStatus: string | null;
    joinCode: string | null;
    joinCodeExpiry: number | null;
    upcomingSessions: Array<{ sessionId: string; startTime: number; endTime: number | null; isActive: boolean }>;
    isMuted: boolean;
  },
  reducers: {},
});

export const roomServiceReducer = roomServiceSlice.reducer;
