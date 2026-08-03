import type { Room, Session } from '@scribear/session-manager-schema';

export function buildSession(overrides: Partial<Session> = {}): Session {
  return {
    uid: 'session-1',
    roomUid: 'room-1',
    name: 'CS 225 Lecture',
    type: 'SCHEDULED',
    scheduledSessionUid: null,
    scheduledStartTime: '2026-08-01T14:00:00.000Z',
    scheduledEndTime: '2026-08-01T14:50:00.000Z',
    startOverride: null,
    endOverride: null,
    canceledAt: null,
    effectiveStart: '2026-08-01T14:00:00.000Z',
    effectiveEnd: '2026-08-01T14:50:00.000Z',
    joinCodeScopes: ['SEND_AUDIO', 'RECEIVE_TRANSCRIPTIONS'],
    transcriptionProviderId: 'whisper',
    transcriptionStreamConfig: {},
    sessionConfigVersion: 1,
    createdAt: '2026-08-01T00:00:00.000Z',
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
