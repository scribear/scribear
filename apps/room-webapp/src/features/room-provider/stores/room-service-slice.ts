import { createSlice } from '@reduxjs/toolkit';

interface UpcomingSession {
  sessionId: string;
  startTime: number;
  endTime: number | null;
  isActive: boolean;
}

interface RoomServiceState {
  roomServiceStatus: string | null;
  sessionStatus: string | null;
  joinCode: string | null;
  joinCodeExpiry: number | null;
  upcomingSessions: UpcomingSession[];
  isMuted: boolean;
}

const initialState: RoomServiceState = {
  roomServiceStatus: null,
  sessionStatus: null,
  joinCode: null,
  joinCodeExpiry: null,
  upcomingSessions: [],
  isMuted: false,
};

const roomServiceSlice = createSlice({
  name: 'roomService',
  initialState,
  reducers: {},
});

export const roomServiceReducer = roomServiceSlice.reducer;
export type { RoomServiceState, UpcomingSession };
