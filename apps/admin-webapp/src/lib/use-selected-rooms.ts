import { useCallback, useState } from 'react';

import type { Room } from '@scribear/session-manager-schema';

const STORAGE_KEY = 'scribear-admin:sessions-selected-rooms';

function readStoredRooms(): Room[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Room[]) : [];
  } catch {
    return [];
  }
}

/**
 * Persists the sessions-overview room selection to localStorage, kept
 * separate from `SettingsContext` since this is a page-specific preference,
 * not a cross-cutting app setting like "Show UUIDs".
 */
export function useSelectedRooms(): [Room[], (rooms: Room[]) => void] {
  const [rooms, setRooms] = useState<Room[]>(readStoredRooms);

  const update = useCallback((next: Room[]) => {
    setRooms(next);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Best-effort persistence; the selection still works for this session.
    }
  }, []);

  return [rooms, update];
}
