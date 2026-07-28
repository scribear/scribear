import type { Device, Room, Session } from '@scribear/session-manager-schema';

import type { RoomDetail } from '#src/lib/admin-api';

export function buildSession(overrides: Partial<Session> = {}): Session {
  return {
    uid: 'session-1',
    roomUid: 'room-1',
    name: 'Morning lecture',
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

export function buildDevice(overrides: Partial<Device> = {}): Device {
  return {
    uid: 'device-1',
    name: 'Kiosk 1',
    active: false,
    roomUid: null,
    isSource: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    lastSeenAt: null,
    online: false,
    ...overrides,
  };
}

export function buildRoomDetail(
  overrides: {
    room?: Partial<Room>;
    devices?: Device[];
  } = {},
): RoomDetail {
  return {
    room: buildRoom(overrides.room),
    devices: overrides.devices ?? [],
  };
}
