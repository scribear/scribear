import { fireEvent, screen, waitFor } from '@testing-library/react';
import { axe } from 'jest-axe';
import { afterEach, beforeEach, describe, expect, vi } from 'vitest';

import { DevicesListPage } from '#src/features/devices/devices-list-page';
import { adminApi } from '#src/lib/admin-api';
import { ApiError } from '#src/lib/api-error';

import { renderWithProviders } from '../../utils/render-with-providers';
import { buildDevice } from './fixtures';

vi.mock('#src/lib/admin-api', () => ({
  adminApi: {
    listDevices: vi.fn(),
    listRooms: vi.fn(),
    registerDevice: vi.fn(),
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

  describe('Presence', (it) => {
    it('shows Online for a device currently connected', async () => {
      // Arrange
      vi.mocked(adminApi.listDevices).mockResolvedValue({
        items: [
          buildDevice({
            uid: 'device-1',
            name: 'Kiosk 1',
            online: true,
            lastSeenAt: '2026-01-01T12:00:00.000Z',
          }),
        ],
        nextCursor: null,
      });

      // Act
      renderWithProviders(<DevicesListPage />);
      await waitForLoad();

      // Assert
      expect(screen.getByText('Online')).toBeInTheDocument();
    });

    it('flags an activated device that has gone offline as a real problem, distinct from a merely-pending one', async () => {
      // Arrange: Active + Offline is the "unplugged kiosk" case — the device
      // was set up and is expected to be reachable, so this gets a `warning`
      // color rather than the neutral one an unactivated device gets.
      vi.mocked(adminApi.listDevices).mockResolvedValue({
        items: [
          buildDevice({
            uid: 'device-1',
            name: 'Kiosk 1',
            active: true,
            online: false,
            lastSeenAt: '2026-01-01T08:00:00.000Z',
          }),
        ],
        nextCursor: null,
      });

      // Act
      renderWithProviders(<DevicesListPage />);
      await waitForLoad();

      // Assert
      expect(screen.getByText('Offline').closest('.MuiChip-root')).toHaveClass(
        'MuiChip-colorWarning',
      );
    });

    it('does not flag a not-yet-activated device that has never connected as a problem', async () => {
      // Arrange
      vi.mocked(adminApi.listDevices).mockResolvedValue({
        items: [
          buildDevice({
            uid: 'device-1',
            name: 'Kiosk 1',
            active: false,
            online: false,
            lastSeenAt: null,
          }),
        ],
        nextCursor: null,
      });

      // Act
      renderWithProviders(<DevicesListPage />);
      await waitForLoad();

      // Assert
      expect(screen.getByText('Offline').closest('.MuiChip-root')).toHaveClass(
        'MuiChip-colorDefault',
      );
    });

    it('shows the last-seen time on hover, distinguishing "seen before" from "never seen"', async () => {
      // Arrange
      vi.mocked(adminApi.listDevices).mockResolvedValue({
        items: [
          buildDevice({
            uid: 'device-1',
            name: 'Kiosk 1',
            active: true,
            online: false,
            lastSeenAt: '2026-01-01T08:00:00.000Z',
          }),
        ],
        nextCursor: null,
      });
      renderWithProviders(<DevicesListPage />);
      await waitForLoad();

      // Act
      fireEvent.mouseOver(screen.getByText('Offline'));

      // Assert
      expect(
        await screen.findByText(
          `Last seen ${new Date('2026-01-01T08:00:00.000Z').toLocaleString()}`,
        ),
      ).toBeInTheDocument();
    });
  });

  describe('Register device dialog — kiosk URL', (it) => {
    afterEach(() => {
      vi.unstubAllGlobals();
      // Undo the clipboard stub some of these tests install; jsdom has no
      // Clipboard API by default, matching a browser that reaches this
      // console over an insecure (plain HTTP) connection.
      Reflect.deleteProperty(navigator, 'clipboard');
    });

    // Plain `fireEvent`, deliberately not `userEvent`: `userEvent.setup()`
    // unconditionally installs its own jsdom Clipboard stub on
    // `navigator.clipboard` (`Clipboard.attachClipboardStubToView`, called
    // from `setup()` regardless of the `writeToClipboard` option), which
    // would both mask the "Clipboard API is unavailable" branch under test
    // below and clobber the `writeText` mock the "copies the URL" case
    // installs. Fire-and-forget events avoid that side effect entirely.
    async function openDialogWithResult() {
      vi.mocked(adminApi.listDevices).mockResolvedValue({
        items: [],
        nextCursor: null,
      });
      vi.mocked(adminApi.registerDevice).mockResolvedValue({
        deviceUid: 'device-1',
        activationCode: 'ABC123',
        expiry: new Date(Date.now() + 5 * 60_000).toISOString(),
      });

      const rendered = renderWithProviders(<DevicesListPage />);
      await waitForLoad();
      fireEvent.click(screen.getByRole('button', { name: 'Register device' }));
      fireEvent.change(screen.getByLabelText('Device name'), {
        target: { value: 'Kiosk 1' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Register device' }));
      await screen.findByText('ABC123');

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
      await openDialogWithResult();

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
      await openDialogWithResult();
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
      await openDialogWithResult();

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
      await openDialogWithResult();

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
