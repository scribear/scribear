import { screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Room } from '@scribear/session-manager-schema';

import { SessionsOverviewPage } from '#src/features/sessions/sessions-overview-page';
import { adminApi } from '#src/lib/admin-api';
import { ApiError } from '#src/lib/api-error';
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

  it('never says "No sessions today." in every room when the load failed', async () => {
    // Arrange - the §5 shape on this page: a failed session load left
    // `sessions` empty, so every room card reported a quiet day.
    const rooms = manyRooms(GRID_MAX_COLUMNS + 1);
    seedSelectedRooms(rooms);
    vi.mocked(adminApi.listSessions).mockRejectedValue(
      new ApiError('UPSTREAM_UNREACHABLE', 'unreachable', 503, 'req-42'),
    );

    // Act
    renderWithProviders(<SessionsOverviewPage />);

    // Assert
    expect(
      await screen.findByText('Could not load sessions.'),
    ).toBeInTheDocument();
    expect(screen.queryByText('No sessions today.')).not.toBeInTheDocument();
    expect(screen.getByText('req-42')).toBeInTheDocument();
  });

  it('still says "No sessions today." when the day really is empty', async () => {
    // Arrange
    const rooms = manyRooms(GRID_MAX_COLUMNS + 1);
    seedSelectedRooms(rooms);
    vi.mocked(adminApi.listSessions).mockResolvedValue({ items: [] });

    // Act
    renderWithProviders(<SessionsOverviewPage />);
    await waitFor(() => {
      expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    });

    // Assert
    expect(screen.queryAllByText('No sessions today.')).toHaveLength(
      rooms.length,
    );
    expect(
      screen.queryByText('Could not load sessions.'),
    ).not.toBeInTheDocument();
  });

  it('explains an unusable picker instead of telling the operator to select rooms from it', async () => {
    // Arrange - with no persisted selection the page fetches rooms to seed a
    // default. That catch was silent, so a dead backend rendered "Select rooms
    // above to view their calendar." above a picker that could not list any.
    vi.mocked(adminApi.listRooms).mockRejectedValue(
      new ApiError('UPSTREAM_UNREACHABLE', 'unreachable', 503),
    );

    // Act
    renderWithProviders(<SessionsOverviewPage />);

    // Assert
    expect(
      await screen.findByText('Could not load the room list.'),
    ).toBeInTheDocument();
    expect(
      screen.queryByText('Select rooms above to view their calendar.'),
    ).not.toBeInTheDocument();
  });
});
