import { screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Room } from '@scribear/session-manager-schema';

import { SessionsOverviewPage } from '#src/features/sessions/sessions-overview-page';
import { adminApi } from '#src/lib/admin-api';
import { GRID_MAX_COLUMNS } from '#src/lib/session-rules';

import { renderWithProviders } from '../../utils/render-with-providers';
import { buildRoom } from './fixtures';

vi.mock('#src/lib/admin-api', () => ({
  adminApi: { listRooms: vi.fn(), listSessions: vi.fn() },
}));

// List mode only kicks in above GRID_MAX_COLUMNS selected rooms (grid mode
// covers 1..GRID_MAX_COLUMNS) — force list mode by stubbing the persisted
// selection with more rooms than that, same storage key `useSelectedRooms`
// itself reads from.
const SELECTED_ROOMS_KEY = 'scribear-admin:sessions-selected-rooms';

function seedSelectedRooms(rooms: Room[]) {
  localStorage.setItem(SELECTED_ROOMS_KEY, JSON.stringify(rooms));
}

function manyRooms(count: number): Room[] {
  return Array.from({ length: count }, (_, i) =>
    buildRoom({ uid: `room-${String(i)}`, name: `Room ${String(i)}` }),
  );
}

describe('SessionsOverviewPage', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(adminApi.listSessions).mockResolvedValue({ items: [] });
    // RoomPicker (rendered by the page) fetches on mount with an empty
    // search string; give it something to resolve to so it doesn't reject.
    vi.mocked(adminApi.listRooms).mockResolvedValue({
      items: [],
      nextCursor: null,
    });
  });

  it('renders each selected room name as a level-2 heading in list mode', async () => {
    const rooms = manyRooms(GRID_MAX_COLUMNS + 1);
    seedSelectedRooms(rooms);

    renderWithProviders(<SessionsOverviewPage />);

    await waitFor(() => {
      expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    });

    for (const room of rooms) {
      expect(
        screen.getByRole('heading', { level: 2, name: room.name }),
      ).toBeInTheDocument();
    }
  });
});
