import type {
  AutoSessionWindow,
  Room,
  Session,
  SessionSchedule,
} from '@scribear/session-manager-schema';

import type { RoomDetail } from '#src/lib/admin-api';

export function buildSession(overrides: Partial<Session> = {}): Session {
  return {
    uid: 'session-1',
    roomUid: 'room-1',
    name: 'On-demand session',
    type: 'ON_DEMAND',
    scheduledSessionUid: null,
    scheduledStartTime: '2026-01-01T10:00:00.000Z',
    scheduledEndTime: '2026-01-01T11:00:00.000Z',
    startOverride: null,
    endOverride: null,
    effectiveStart: '2026-01-01T10:00:00.000Z',
    effectiveEnd: '2026-01-01T11:00:00.000Z',
    joinCodeScopes: ['RECEIVE_TRANSCRIPTIONS'],
    transcriptionProviderId: 'whisper',
    transcriptionStreamConfig: {},
    sessionConfigVersion: 1,
    createdAt: '2026-01-01T09:00:00.000Z',
    ...overrides,
  };
}

export function buildRoom(overrides: Partial<Room> = {}): Room {
  return {
    uid: 'room-1',
    name: 'Room 101',
    timezone: 'America/Chicago',
    autoSessionEnabled: false,
    roomScheduleVersion: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

export function buildRoomDetail(overrides: Partial<Room> = {}): RoomDetail {
  return { room: buildRoom(overrides), devices: [] };
}

export function buildSchedule(
  overrides: Partial<SessionSchedule> = {},
): SessionSchedule {
  return {
    uid: 'schedule-1',
    roomUid: 'room-1',
    name: 'CS 225 Lecture',
    activeStart: '2026-08-01T14:00:00.000Z',
    activeEnd: null,
    anchorStart: '2026-08-01T14:00:00.000Z',
    localStartTime: '09:00:00',
    localEndTime: '09:50:00',
    frequency: 'WEEKLY',
    daysOfWeek: ['MON', 'WED', 'FRI'],
    joinCodeScopes: ['SEND_AUDIO', 'RECEIVE_TRANSCRIPTIONS'],
    transcriptionProviderId: 'whisper',
    transcriptionStreamConfig: {},
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

export function buildWindow(
  overrides: Partial<AutoSessionWindow> = {},
): AutoSessionWindow {
  return {
    uid: 'window-1',
    roomUid: 'room-1',
    localStartTime: '08:00:00',
    localEndTime: '17:00:00',
    daysOfWeek: ['MON', 'TUE', 'WED', 'THU', 'FRI'],
    joinCodeScopes: ['SEND_AUDIO', 'RECEIVE_TRANSCRIPTIONS'],
    transcriptionProviderId: 'whisper',
    transcriptionStreamConfig: {},
    activeStart: '2026-08-01T00:00:00.000Z',
    activeEnd: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}
