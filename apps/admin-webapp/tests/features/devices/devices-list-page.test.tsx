import { screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, vi } from 'vitest';

import { DevicesListPage } from '#src/features/devices/devices-list-page';
import { adminApi } from '#src/lib/admin-api';
import { ApiError } from '#src/lib/api-error';

import { renderWithProviders } from '../../utils/render-with-providers';
import { buildDevice } from './fixtures';

vi.mock('#src/lib/admin-api', () => ({
  adminApi: {
    listDevices: vi.fn(),
    listRooms: vi.fn(),
  },
}));

async function waitForLoad() {
  await waitFor(() => {
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });
}

describe('DevicesListPage', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Backs useRoomNameLookup, which every render kicks off regardless of the
    // states under test here; failures there are swallowed by the hook, but
    // giving it an empty list keeps it from ever settling into a warning.
    vi.mocked(adminApi.listRooms).mockResolvedValue({
      items: [],
      nextCursor: null,
    });
  });

  describe('loading', (it) => {
    it('shows a spinner while the initial load is in flight', () => {
      // Arrange
      vi.mocked(adminApi.listDevices).mockReturnValue(
        new Promise(() => {
          /* never resolves */
        }),
      );

      // Act
      renderWithProviders(<DevicesListPage />);

      // Assert
      expect(screen.getByRole('progressbar')).toBeInTheDocument();
    });
  });

  describe('empty state', (it) => {
    it('shows "No devices found." when the API returns an empty list', async () => {
      // Arrange
      vi.mocked(adminApi.listDevices).mockResolvedValue({
        items: [],
        nextCursor: null,
      });

      // Act
      renderWithProviders(<DevicesListPage />);
      await waitForLoad();

      // Assert
      expect(screen.getByText('No devices found.')).toBeInTheDocument();
    });
  });

  describe('error state', (it) => {
    it('shows a toast and falls back to the empty state on a non-ApiError rejection', async () => {
      // Arrange
      vi.mocked(adminApi.listDevices).mockRejectedValue(
        new Error('network down'),
      );

      // Act
      renderWithProviders(<DevicesListPage />);
      await waitForLoad();

      // Assert
      expect(
        await screen.findByText('Failed to load devices.'),
      ).toBeInTheDocument();
      expect(screen.getByText('No devices found.')).toBeInTheDocument();
    });
  });

  describe('BACKEND_MISCONFIGURATION', (it) => {
    it('shows the ADMIN_API_KEY alert instead of a toast', async () => {
      // Arrange
      vi.mocked(adminApi.listDevices).mockRejectedValue(
        new ApiError('BACKEND_MISCONFIGURATION', 'nope', 502),
      );

      // Act
      renderWithProviders(<DevicesListPage />);
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
      vi.mocked(adminApi.listDevices).mockResolvedValue({
        items: [buildDevice({ uid: 'device-1', name: 'Kiosk 1' })],
        nextCursor: null,
      });

      // Act
      renderWithProviders(<DevicesListPage />);
      await waitForLoad();

      // Assert
      expect(screen.getByText('Kiosk 1')).toBeInTheDocument();
      expect(screen.queryByText('device-1')).not.toBeInTheDocument();
    });

    it('renders the uid under the name when the setting is on', async () => {
      // Arrange
      localStorage.setItem('scribear-admin:show-uuids', 'true');
      vi.mocked(adminApi.listDevices).mockResolvedValue({
        items: [buildDevice({ uid: 'device-1', name: 'Kiosk 1' })],
        nextCursor: null,
      });

      // Act
      renderWithProviders(<DevicesListPage />);
      await waitForLoad();

      // Assert
      expect(screen.getByText('Kiosk 1')).toBeInTheDocument();
      expect(screen.getByText('device-1')).toBeInTheDocument();
    });
  });
});
