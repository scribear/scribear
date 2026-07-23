import type { Device, Room } from '@scribear/session-manager-schema';

import type { RoomDetail } from '#src/lib/admin-api';

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
