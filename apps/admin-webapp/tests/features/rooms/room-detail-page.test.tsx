import type { ReactElement } from 'react';

import { beforeEach, describe, expect, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';

import { Route, Routes } from 'react-router-dom';

import { RoomDetailPage } from '#src/features/rooms/room-detail-page';
import { adminApi } from '#src/lib/admin-api';
import { ApiError } from '#src/lib/api-error';

import { renderWithProviders } from '../../utils/render-with-providers';
import { buildDevice, buildRoomDetail } from './fixtures';

vi.mock('#src/lib/admin-api', () => ({
  adminApi: {
    roomDetail: vi.fn(),
  },
}));

const ROOM_UID = 'room-1';

function renderPage(ui: ReactElement = <RoomDetailPage />) {
  return renderWithProviders(
    <Routes>
      <Route path="/rooms/:roomUid" element={ui} />
    </Routes>,
    { route: `/rooms/${ROOM_UID}` },
  );
}

async function waitForLoad() {
  await waitFor(() => {
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });
}

describe('RoomDetailPage', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe('loading', (it) => {
    it('shows a spinner while the initial load is in flight', () => {
      // Arrange
      vi.mocked(adminApi.roomDetail).mockReturnValue(
        new Promise(() => {
          /* never resolves */
        }),
      );

      // Act
      renderPage();

      // Assert
      expect(screen.getByRole('progressbar')).toBeInTheDocument();
    });
  });

  describe('empty state', (it) => {
    it('shows "No devices assigned to this room." when the room has no devices', async () => {
      // Arrange
      vi.mocked(adminApi.roomDetail).mockResolvedValue(
        buildRoomDetail({ devices: [] }),
      );

      // Act
      renderPage();
      await waitForLoad();

      // Assert
      expect(
        screen.getByText('No devices assigned to this room.'),
      ).toBeInTheDocument();
    });
  });

  describe('error / not-found state', (it) => {
    it('shows a toast and a "Room not found." fallback on a non-ApiError rejection', async () => {
      // Arrange
      vi.mocked(adminApi.roomDetail).mockRejectedValue(
        new Error('network down'),
      );

      // Act
      renderPage();
      await waitForLoad();

      // Assert
      expect(
        await screen.findByText('Failed to load room.'),
      ).toBeInTheDocument();
      expect(screen.getByText('Room not found.')).toBeInTheDocument();
    });
  });

  describe('BACKEND_MISCONFIGURATION', (it) => {
    it('shows the ADMIN_API_KEY alert as the entire page body', async () => {
      // Arrange
      vi.mocked(adminApi.roomDetail).mockRejectedValue(
        new ApiError('BACKEND_MISCONFIGURATION', 'nope', 502),
      );

      // Act
      renderPage();
      await waitForLoad();

      // Assert
      expect(
        await screen.findByText(/admin backend misconfiguration/i),
      ).toBeInTheDocument();
      expect(screen.queryByText('Room not found.')).not.toBeInTheDocument();
    });
  });

  describe('Show UUIDs setting', (it) => {
    it('renders just the names when the setting is off', async () => {
      // Arrange
      vi.mocked(adminApi.roomDetail).mockResolvedValue(
        buildRoomDetail({
          room: { uid: ROOM_UID, name: 'Room 101' },
          devices: [buildDevice({ uid: 'device-1', name: 'Kiosk 1' })],
        }),
      );

      // Act
      renderPage();
      await waitForLoad();

      // Assert
      expect(screen.getByText('Room 101')).toBeInTheDocument();
      expect(screen.getByText('Kiosk 1')).toBeInTheDocument();
      expect(screen.queryByText(ROOM_UID)).not.toBeInTheDocument();
      expect(screen.queryByText('device-1')).not.toBeInTheDocument();
    });

    it('renders the uids under the names when the setting is on', async () => {
      // Arrange
      localStorage.setItem('scribear-admin:show-uuids', 'true');
      vi.mocked(adminApi.roomDetail).mockResolvedValue(
        buildRoomDetail({
          room: { uid: ROOM_UID, name: 'Room 101' },
          devices: [buildDevice({ uid: 'device-1', name: 'Kiosk 1' })],
        }),
      );

      // Act
      renderPage();
      await waitForLoad();

      // Assert
      expect(screen.getByText(ROOM_UID)).toBeInTheDocument();
      expect(screen.getByText('device-1')).toBeInTheDocument();
    });
  });
});
