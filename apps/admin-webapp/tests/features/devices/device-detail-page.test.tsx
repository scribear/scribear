import type { ReactElement } from 'react';

import { fireEvent, screen, waitFor } from '@testing-library/react';
import { axe } from 'jest-axe';
import { Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, vi } from 'vitest';

import { DeviceDetailPage } from '#src/features/devices/device-detail-page';
import { adminApi } from '#src/lib/admin-api';
import { ApiError } from '#src/lib/api-error';

import { renderWithProviders } from '../../utils/render-with-providers';
import { buildDevice, buildRoom } from './fixtures';

vi.mock('#src/lib/admin-api', () => ({
  adminApi: {
    getDevice: vi.fn(),
    getRoom: vi.fn(),
    reregisterDevice: vi.fn(),
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

  describe('Presence', (it) => {
    // §4.5: the device detail page previously had no presence field at all —
    // the deepest page in the console carried strictly less information than
    // the devices list. These pin that the fact is now visible, and that it
    // reads plainly (not only inside a hover tooltip, unlike the list/room
    // table) since this is the page an operator lands on to answer "is this
    // kiosk plugged in?".
    it('shows Online and when it was last seen for a device currently connected', async () => {
      // Arrange
      vi.mocked(adminApi.getDevice).mockResolvedValue(
        buildDevice({
          uid: DEVICE_UID,
          online: true,
          lastSeenAt: '2026-01-01T12:00:00.000Z',
        }),
      );

      // Act
      renderPage();
      await waitForLoad();

      // Assert
      expect(screen.getByText('Online')).toBeInTheDocument();
      expect(
        screen.getByText(
          `Last seen ${new Date('2026-01-01T12:00:00.000Z').toLocaleString()}`,
        ),
      ).toBeInTheDocument();
    });

    it('shows Offline and the last time it was seen for a device that has disconnected', async () => {
      // Arrange
      vi.mocked(adminApi.getDevice).mockResolvedValue(
        buildDevice({
          uid: DEVICE_UID,
          active: true,
          online: false,
          lastSeenAt: '2026-01-01T08:00:00.000Z',
        }),
      );

      // Act
      renderPage();
      await waitForLoad();

      // Assert
      expect(screen.getByText('Offline')).toBeInTheDocument();
      expect(
        screen.getByText(
          `Last seen ${new Date('2026-01-01T08:00:00.000Z').toLocaleString()}`,
        ),
      ).toBeInTheDocument();
    });

    it('shows "Never seen" for a device that has never connected — distinct from having gone offline after being seen', async () => {
      // Arrange
      vi.mocked(adminApi.getDevice).mockResolvedValue(
        buildDevice({
          uid: DEVICE_UID,
          active: false,
          online: false,
          lastSeenAt: null,
        }),
      );

      // Act
      renderPage();
      await waitForLoad();

      // Assert
      expect(screen.getByText('Offline')).toBeInTheDocument();
      expect(screen.getByText('Never seen')).toBeInTheDocument();
    });
  });

  describe('Re-register device dialog — kiosk URL', (it) => {
    afterEach(() => {
      vi.unstubAllGlobals();
      // Undo the clipboard stub some of these tests install; jsdom has no
      // Clipboard API by default, matching a browser that reaches this
      // console over an insecure (plain HTTP) connection.
      Reflect.deleteProperty(navigator, 'clipboard');
    });

    // Plain `fireEvent`, deliberately not `userEvent`: see the same-named
    // helper in devices-list-page.test.tsx for why (`userEvent.setup()`
    // unconditionally installs its own Clipboard stub).
    async function openReregisterResult() {
      vi.mocked(adminApi.getDevice).mockResolvedValue(
        buildDevice({ uid: DEVICE_UID, name: 'Kiosk 1', roomUid: null }),
      );
      vi.mocked(adminApi.reregisterDevice).mockResolvedValue({
        activationCode: 'XYZ789',
        expiry: new Date(Date.now() + 5 * 60_000).toISOString(),
      });

      const rendered = renderPage();
      await waitForLoad();
      // First click opens the confirm dialog; the trigger button behind it is
      // then `aria-hidden`, so the second "Re-register" query resolves to the
      // confirm dialog's own button, not a second match on the first.
      fireEvent.click(screen.getByRole('button', { name: 'Re-register' }));
      fireEvent.click(screen.getByRole('button', { name: 'Re-register' }));
      await screen.findByText('XYZ789');

      return rendered;
    }

    it('builds the kiosk link from the page origin rather than a hardcoded value', async () => {
      // Arrange: a distinctive origin — one the component never sees written
      // anywhere in source — is the only way to prove the URL comes from
      // `window.location`, not a baked-in scheme/host/port.
      vi.stubGlobal('location', {
        origin: 'https://scribear.example.edu:8443',
      });

      // Act
      await openReregisterResult();

      // Assert
      const link = screen.getByRole('link', { name: /\/kiosk/ });
      expect(link).toHaveAttribute(
        'href',
        'https://scribear.example.edu:8443/kiosk',
      );
    });

    it('labels the copy button by what it copies and puts the URL — not the code — on the clipboard', async () => {
      // Arrange: the activation code already has its own "Copy activation
      // code" button (ActivationCodeDisplay); this one must be unmistakably
      // about the URL instead.
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText },
        configurable: true,
      });

      // Act
      await openReregisterResult();
      expect(
        screen.getByRole('button', { name: 'Copy activation code' }),
      ).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Copy kiosk URL' }));

      // Assert
      expect(writeText).toHaveBeenCalledWith('http://localhost:3000/kiosk');
      expect(await screen.findByText('Kiosk URL copied.')).toBeInTheDocument();
    });

    it('tells the operator to copy the link manually when the Clipboard API is unavailable', async () => {
      // Arrange: no navigator.clipboard stub — jsdom's own default, standing
      // in for a non-secure-context deployment where the API never exists.
      await openReregisterResult();

      // Act
      fireEvent.click(screen.getByRole('button', { name: 'Copy kiosk URL' }));

      // Assert: the failure is announced (via the toast) and the link text
      // remains on screen, selectable by hand.
      expect(
        await screen.findByText(/clipboard access isn.t available/i),
      ).toBeInTheDocument();
      expect(screen.getByRole('link', { name: /\/kiosk/ })).toBeInTheDocument();
    });

    it('has no a11y violations with the dialog open', async () => {
      // MUI's Dialog portals its content to document.body rather than the
      // rendered container, so the copy button / link markup this test cares
      // about only shows up when axe scans the body. The scaffolding rules
      // disabled below fire because this is a bare component under test, not
      // the full app shell with its landmarks/heading/lang/title — pre-existing
      // per the mock-server a11y tooling notes, not introduced here.
      await openReregisterResult();

      const results = await axe(document.body, {
        rules: {
          region: { enabled: false },
          'landmark-one-main': { enabled: false },
          'page-has-heading-one': { enabled: false },
          'html-has-lang': { enabled: false },
          'document-title': { enabled: false },
          bypass: { enabled: false },
        },
      });

      expect(results.violations).toHaveLength(0);
    });
  });
});
