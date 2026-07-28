import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import type { Room } from '@scribear/session-manager-schema';

import { useSelectedRooms } from '#src/lib/use-selected-rooms';

const STORAGE_KEY = 'scribear-admin:sessions-selected-rooms';

function makeRoom(overrides: Partial<Room> = {}): Room {
  return {
    uid: 'room-1',
    name: 'Room 1',
    timezone: 'America/Chicago',
    autoSessionEnabled: false,
    roomScheduleVersion: 1,
    createdAt: '2026-06-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('useSelectedRooms', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('starts empty when nothing is persisted', () => {
    const { result } = renderHook(() => useSelectedRooms());
    expect(result.current[0]).toEqual([]);
  });

  it('persists a new selection to localStorage and reflects it in state', () => {
    const { result } = renderHook(() => useSelectedRooms());
    const rooms = [makeRoom()];

    act(() => {
      result.current[1](rooms);
    });

    expect(result.current[0]).toEqual(rooms);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null')).toEqual(
      rooms,
    );
  });

  it('reads back a previously persisted selection on mount', () => {
    const rooms = [makeRoom({ uid: 'room-2', name: 'Room 2' })];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(rooms));

    const { result } = renderHook(() => useSelectedRooms());
    expect(result.current[0]).toEqual(rooms);
  });

  it('falls back to [] when storage is corrupted', () => {
    localStorage.setItem(STORAGE_KEY, '{not valid json');
    const { result } = renderHook(() => useSelectedRooms());
    expect(result.current[0]).toEqual([]);
  });
});
