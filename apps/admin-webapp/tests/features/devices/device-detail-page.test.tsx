import type { ReactElement } from 'react';

import { screen, waitFor } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, vi } from 'vitest';

import { DeviceDetailPage } from '#src/features/devices/device-detail-page';
import { adminApi } from '#src/lib/admin-api';
import { ApiError } from '#src/lib/api-error';

import { renderWithProviders } from '../../utils/render-with-providers';
import { buildDevice, buildRoom } from './fixtures';

vi.mock('#src/lib/admin-api', () => ({
  adminApi: {
    getDevice: vi.fn(),
    getRoom: vi.fn(),
  },
}));

const DEVICE_UID = 'device-1';

function renderPage(ui: ReactElement = <DeviceDetailPage />) {
  return renderWithProviders(
    <Routes>
      <Route path="/devices/:deviceUid" element={ui} />
    </Routes>,
    { route: `/devices/${DEVICE_UID}` },
  );
}

async function waitForLoad() {
  await waitFor(() => {
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });
}

describe('DeviceDetailPage', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe('loading', (it) => {
    it('shows a spinner while the initial load is in flight', () => {
      // Arrange
      vi.mocked(adminApi.getDevice).mockReturnValue(
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

  describe('not-found state', (it) => {
    it('shows "Device not found." on a 404 ApiError', async () => {
      // Arrange
      vi.mocked(adminApi.getDevice).mockRejectedValue(
        new ApiError('NOT_FOUND', 'no such device', 404),
      );

      // Act
      renderPage();
      await waitForLoad();

      // Assert
      expect(await screen.findByText('Device not found.')).toBeInTheDocument();
    });
  });

  describe('error state', (it) => {
    it('shows a toast and the not-found fallback on a non-404, non-ApiError rejection', async () => {
      // Arrange
      vi.mocked(adminApi.getDevice).mockRejectedValue(
        new Error('network down'),
      );

      // Act
      renderPage();
      await waitForLoad();

      // Assert
      expect(
        await screen.findByText('Failed to load device.'),
      ).toBeInTheDocument();
      expect(screen.getByText('Device not found.')).toBeInTheDocument();
    });
  });

  describe('BACKEND_MISCONFIGURATION', (it) => {
    it('shows the ADMIN_API_KEY alert as the entire page body', async () => {
      // Arrange
      vi.mocked(adminApi.getDevice).mockRejectedValue(
        new ApiError('BACKEND_MISCONFIGURATION', 'nope', 502),
      );

      // Act
      renderPage();
      await waitForLoad();

      // Assert
      expect(
        await screen.findByText(/admin backend misconfiguration/i),
      ).toBeInTheDocument();
      expect(screen.queryByText('Device not found.')).not.toBeInTheDocument();
    });
  });

  describe('Show UUIDs setting', (it) => {
    it('renders just the names when the setting is off', async () => {
      // Arrange
      vi.mocked(adminApi.getDevice).mockResolvedValue(
        buildDevice({ uid: DEVICE_UID, name: 'Kiosk 1', roomUid: 'room-1' }),
      );
      vi.mocked(adminApi.getRoom).mockResolvedValue(
        buildRoom({ uid: 'room-1', name: 'Room 101' }),
      );

      // Act
      renderPage();
      await waitForLoad();
      await screen.findByText('Room 101');

      // Assert
      expect(screen.getByText('Kiosk 1')).toBeInTheDocument();
      expect(screen.queryByText(DEVICE_UID)).not.toBeInTheDocument();
      expect(screen.queryByText('room-1')).not.toBeInTheDocument();
    });

    it('renders the uids under the names when the setting is on', async () => {
      // Arrange
      localStorage.setItem('scribear-admin:show-uuids', 'true');
      vi.mocked(adminApi.getDevice).mockResolvedValue(
        buildDevice({ uid: DEVICE_UID, name: 'Kiosk 1', roomUid: 'room-1' }),
      );
      vi.mocked(adminApi.getRoom).mockResolvedValue(
        buildRoom({ uid: 'room-1', name: 'Room 101' }),
      );

      // Act
      renderPage();
      await waitForLoad();
      await screen.findByText('Room 101');

      // Assert
      expect(screen.getByText(DEVICE_UID)).toBeInTheDocument();
      expect(screen.getByText('room-1')).toBeInTheDocument();
    });
  });
});
