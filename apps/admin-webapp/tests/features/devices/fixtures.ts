import type { Device, Room } from '@scribear/session-manager-schema';

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
