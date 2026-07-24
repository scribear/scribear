import { adminApi } from '#src/lib/admin-api';
import { useAsyncData } from '#src/lib/use-async-data';

/**
 * Fetches every room once and returns a `roomUid -> name` map, so pages that
 * only carry a device's `roomUid` (the Device entity has no room name field)
 * can render the room's display name instead. Fetch failures are swallowed —
 * callers fall back to showing the raw uid when a name isn't in the map.
 */
export function useRoomNameLookup(): Map<string, string> {
  const { data } = useAsyncData<Map<string, string>>(async () => {
    const map = new Map<string, string>();
    let cursor: string | undefined;
    try {
      for (;;) {
        const query: { limit: number; cursor?: string } = { limit: 200 };
        if (cursor !== undefined) query.cursor = cursor;
        const res = await adminApi.listRooms(query);
        for (const room of res.items) map.set(room.uid, room.name);
        if (res.nextCursor === null) break;
        cursor = res.nextCursor;
      }
    } catch {
      // Non-critical: rows fall back to the raw room uid. Return whatever was
      // accumulated before the failure rather than rejecting.
    }
    return map;
  }, []);

  return data ?? new Map<string, string>();
}
