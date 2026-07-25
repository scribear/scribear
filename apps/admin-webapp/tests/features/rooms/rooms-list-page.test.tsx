import { screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, vi } from 'vitest';

import { RoomsListPage } from '#src/features/rooms/rooms-list-page';
import { adminApi } from '#src/lib/admin-api';
import { ApiError } from '#src/lib/api-error';

import { renderWithProviders } from '../../utils/render-with-providers';
import { buildRoom } from './fixtures';

vi.mock('#src/lib/admin-api', () => ({
  adminApi: {
    listRooms: vi.fn(),
  },
}));

async function waitForLoad() {
  await waitFor(() => {
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });
}

describe('RoomsListPage', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe('loading', (it) => {
    it('shows a spinner while the initial load is in flight', () => {
      // Arrange
      vi.mocked(adminApi.listRooms).mockReturnValue(
        new Promise(() => {
          /* never resolves */
        }),
      );

      // Act
      renderWithProviders(<RoomsListPage />);

      // Assert
      expect(screen.getByRole('progressbar')).toBeInTheDocument();
    });
  });

  describe('empty state', (it) => {
    it('shows "No rooms found." when the API returns an empty list', async () => {
      // Arrange
      vi.mocked(adminApi.listRooms).mockResolvedValue({
        items: [],
        nextCursor: null,
      });

      // Act
      renderWithProviders(<RoomsListPage />);
      await waitForLoad();

      // Assert
      expect(screen.getByText('No rooms found.')).toBeInTheDocument();
    });
  });

  describe('error state', (it) => {
    it('shows a toast and falls back to the empty state on a non-ApiError rejection', async () => {
      // Arrange
      vi.mocked(adminApi.listRooms).mockRejectedValue(
        new Error('network down'),
      );

      // Act
      renderWithProviders(<RoomsListPage />);
      await waitForLoad();

      // Assert
      expect(
        await screen.findByText('Failed to load rooms.'),
      ).toBeInTheDocument();
      expect(screen.getByText('No rooms found.')).toBeInTheDocument();
    });

    it("shows the ApiError's own message in the toast for a non-misconfiguration ApiError", async () => {
      // Arrange
      vi.mocked(adminApi.listRooms).mockRejectedValue(
        new ApiError('SOME_OTHER_CODE', 'Something else went wrong.', 400),
      );

      // Act
      renderWithProviders(<RoomsListPage />);
      await waitForLoad();

      // Assert
      expect(
        await screen.findByText('Something else went wrong.'),
      ).toBeInTheDocument();
    });
  });

  describe('BACKEND_MISCONFIGURATION', (it) => {
    it('shows the ADMIN_API_KEY alert instead of a toast', async () => {
      // Arrange
      vi.mocked(adminApi.listRooms).mockRejectedValue(
        new ApiError('BACKEND_MISCONFIGURATION', 'nope', 502),
      );

      // Act
      renderWithProviders(<RoomsListPage />);
      await waitForLoad();

      // Assert
      expect(
        await screen.findByText(/admin backend misconfiguration/i),
      ).toBeInTheDocument();
    });
  });

  describe('Show UUIDs setting', (it) => {
    it('renders just the name when the setting is off', async () => {
      // Arrange
      vi.mocked(adminApi.listRooms).mockResolvedValue({
        items: [buildRoom({ uid: 'room-1', name: 'Room 101' })],
        nextCursor: null,
      });

      // Act
      renderWithProviders(<RoomsListPage />);
      await waitForLoad();

      // Assert
      expect(screen.getByText('Room 101')).toBeInTheDocument();
      expect(screen.queryByText('room-1')).not.toBeInTheDocument();
    });

    it('renders the uid under the name when the setting is on', async () => {
      // Arrange
      localStorage.setItem('scribear-admin:show-uuids', 'true');
      vi.mocked(adminApi.listRooms).mockResolvedValue({
        items: [buildRoom({ uid: 'room-1', name: 'Room 101' })],
        nextCursor: null,
      });

      // Act
      renderWithProviders(<RoomsListPage />);
      await waitForLoad();

      // Assert
      expect(screen.getByText('Room 101')).toBeInTheDocument();
      expect(screen.getByText('room-1')).toBeInTheDocument();
    });
  });
});
