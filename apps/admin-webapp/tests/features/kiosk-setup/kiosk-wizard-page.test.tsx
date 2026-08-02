import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, vi } from 'vitest';

import { DEMO_ROOM_UID } from '@scribear/session-manager-schema';

import { KioskWizardPage } from '#src/features/kiosk-setup/kiosk-wizard-page';
import { adminApi } from '#src/lib/admin-api';

import { renderWithProviders } from '../../utils/render-with-providers';
import { buildDevice, buildRoom } from './fixtures';

vi.mock('#src/lib/admin-api', () => ({
  adminApi: {
    registerDevice: vi.fn(),
    reregisterDevice: vi.fn(),
    listRooms: vi.fn(),
    createRoom: vi.fn(),
    addDeviceToRoom: vi.fn(),
    setSourceDevice: vi.fn(),
    getDevice: vi.fn(),
  },
}));

// ScheduleStep has its own test file (schedule-step.test.tsx); stubbing it
// here isolates the wizard's step-gating/timezone/polling logic from having
// to also stand up schedule/window API mocks it doesn't otherwise need.
vi.mock('#src/features/kiosk-setup/schedule-step', () => ({
  ScheduleStep: (props: {
    roomUid: string | null;
    roomTimezone: string;
    onCreated: () => void;
  }) => (
    <div>
      <div data-testid="schedule-step-room-uid">{props.roomUid}</div>
      <div data-testid="schedule-step-room-timezone">{props.roomTimezone}</div>
      <button onClick={props.onCreated}>Stub create schedule</button>
    </div>
  ),
}));

async function registerDevice(user: ReturnType<typeof userEvent.setup>) {
  vi.mocked(adminApi.registerDevice).mockResolvedValue({
    deviceUid: 'device-1',
    activationCode: 'ABC123',
    expiry: new Date(Date.now() + 5 * 60_000).toISOString(),
  });
  await user.type(screen.getByLabelText('Device name'), 'Kiosk 1');
  await user.click(screen.getByRole('button', { name: /register device/i }));
  await screen.findByText('ABC123');
}

function clickNext(user: ReturnType<typeof userEvent.setup>) {
  return user.click(screen.getByRole('button', { name: 'Next' }));
}

/** The wizard's advance button reads "Skip" on the Schedule step until a
 * schedule has been created there. */
function clickNextOrSkip(user: ReturnType<typeof userEvent.setup>) {
  return user.click(screen.getByRole('button', { name: /^(next|skip)$/i }));
}

describe('KioskWizardPage', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe('step gating', (it) => {
    it('disables Next on the Device step until a device is registered', async () => {
      // Arrange
      const user = userEvent.setup();
      renderWithProviders(<KioskWizardPage />);

      // Assert
      expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();

      // Act
      await registerDevice(user);

      // Assert
      expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled();
    });

    it('disables Next on the Room step until a room is attached', async () => {
      // Arrange
      const user = userEvent.setup();
      renderWithProviders(<KioskWizardPage />);
      await registerDevice(user);
      await clickNext(user);

      // Assert: Room step, no room yet
      expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();

      // Act
      vi.mocked(adminApi.createRoom).mockResolvedValue(
        buildRoom({ uid: 'room-1' }),
      );
      await user.type(screen.getByLabelText('Room name'), 'Room 101');
      await user.click(screen.getByRole('button', { name: /create room/i }));
      await screen.findByText('room-1', { selector: 'strong' });

      // Assert
      expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled();
    });
  });

  describe('Schedule step button label', (it) => {
    async function reachScheduleStep(user: ReturnType<typeof userEvent.setup>) {
      renderWithProviders(<KioskWizardPage />);
      await registerDevice(user);
      await clickNext(user);
      vi.mocked(adminApi.createRoom).mockResolvedValue(
        buildRoom({ uid: 'room-1' }),
      );
      await user.type(screen.getByLabelText('Room name'), 'Room 101');
      await user.click(screen.getByRole('button', { name: /create room/i }));
      await screen.findByText('room-1', { selector: 'strong' });
      await clickNext(user);
    }

    it('reads "Skip" before a schedule is created and "Next" after', async () => {
      // Arrange
      const user = userEvent.setup();
      await reachScheduleStep(user);

      // Assert
      expect(screen.getByRole('button', { name: 'Skip' })).toBeInTheDocument();

      // Act
      await user.click(
        screen.getByRole('button', { name: /stub create schedule/i }),
      );

      // Assert
      expect(
        screen.queryByRole('button', { name: 'Skip' }),
      ).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Next' })).toBeInTheDocument();
    });
  });

  describe('roomTimezone resolution', (it) => {
    it('passes the picked timezone down the new-room path', async () => {
      // Arrange
      const user = userEvent.setup();
      renderWithProviders(<KioskWizardPage />);
      await registerDevice(user);
      await clickNext(user);
      vi.mocked(adminApi.createRoom).mockResolvedValue(
        buildRoom({ uid: 'room-1', timezone: 'Pacific/Auckland' }),
      );

      // Act
      await user.type(screen.getByLabelText('Room name'), 'Room 101');
      const tzField = screen.getByLabelText(/timezone/i);
      await user.clear(tzField);
      await user.type(tzField, 'Pacific/Auckland');
      await user.click(screen.getByRole('button', { name: /create room/i }));
      await screen.findByText('room-1', { selector: 'strong' });
      await clickNext(user);

      // Assert
      expect(
        screen.getByTestId('schedule-step-room-timezone'),
      ).toHaveTextContent('Pacific/Auckland');
    });

    it("passes the selected existing room's timezone, not the default", async () => {
      // Arrange
      const user = userEvent.setup();
      vi.mocked(adminApi.listRooms).mockResolvedValue({
        items: [
          buildRoom({
            uid: 'room-2',
            name: 'Room 202',
            timezone: 'Asia/Tokyo',
          }),
        ],
        nextCursor: null,
      });
      // Attaching and promoting are two calls: `add-device-to-room` refuses
      // `asSource` on a room that already has a source, so the wizard adds the
      // kiosk as a member and then promotes it with `set-source-device`.
      vi.mocked(adminApi.addDeviceToRoom).mockResolvedValue(null);
      vi.mocked(adminApi.setSourceDevice).mockResolvedValue(null);
      renderWithProviders(<KioskWizardPage />);
      await registerDevice(user);
      await clickNext(user);

      // Act
      await user.click(
        screen.getByRole('radio', { name: /add to an existing room/i }),
      );
      await waitFor(() => {
        expect(adminApi.listRooms).toHaveBeenCalled();
      });
      await user.click(screen.getByRole('combobox', { name: 'Room' }));
      await user.click(screen.getByRole('option', { name: 'Room 202' }));
      await user.click(screen.getByRole('button', { name: /add to room/i }));
      await screen.findByText('room-2', { selector: 'strong' });
      await clickNext(user);

      // Assert: not the DEFAULT_TIMEZONE ('America/Chicago') fallback
      expect(
        screen.getByTestId('schedule-step-room-timezone'),
      ).toHaveTextContent('Asia/Tokyo');
    });
  });

  describe('demo caption room', (it) => {
    it('does not offer the demo caption room as an existing room to join', async () => {
      // Arrange - the demo room's captions come from a fixture and it has no
      // audio path, so the Session Manager refuses `add-device-to-room` for it;
      // offering it here would walk the operator into a 409 at the end of the
      // wizard. The ordinary room in the same response must still be offered —
      // filtering by anything looser would empty this picker.
      const user = userEvent.setup();
      vi.mocked(adminApi.listRooms).mockResolvedValue({
        items: [
          buildRoom({ uid: DEMO_ROOM_UID, name: 'Demo — Alice in Wonderland' }),
          buildRoom({ uid: 'room-2', name: 'Room 202' }),
        ],
        nextCursor: null,
      });
      renderWithProviders(<KioskWizardPage />);
      await registerDevice(user);
      await clickNext(user);

      // Act
      await user.click(
        screen.getByRole('radio', { name: /add to an existing room/i }),
      );
      await waitFor(() => {
        expect(adminApi.listRooms).toHaveBeenCalled();
      });
      await user.click(screen.getByRole('combobox', { name: 'Room' }));

      // Assert
      expect(
        screen.getByRole('option', { name: 'Room 202' }),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole('option', { name: 'Demo — Alice in Wonderland' }),
      ).not.toBeInTheDocument();
    });
  });

  describe('Verify step polling', (it) => {
    it('polls getDevice on an interval and stops polling after unmount', async () => {
      // Arrange: real timers throughout — mixing vitest fake timers with
      // userEvent + RTL's waitFor is unreliable (waitFor's fake-timer
      // detection only recognizes Jest's global `jest`, not vitest), so
      // this exercises the wizard's real POLL_MS=3000ms interval directly.
      const user = userEvent.setup();
      vi.mocked(adminApi.getDevice).mockResolvedValue(
        buildDevice({ uid: 'device-1', active: false }),
      );
      const { unmount } = renderWithProviders(<KioskWizardPage />);
      await registerDevice(user);
      await clickNext(user);
      vi.mocked(adminApi.createRoom).mockResolvedValue(
        buildRoom({ uid: 'room-1' }),
      );
      await user.type(screen.getByLabelText('Room name'), 'Room 101');
      await user.click(screen.getByRole('button', { name: /create room/i }));
      await screen.findByText('room-1', { selector: 'strong' });
      await clickNext(user);
      await clickNextOrSkip(user);
      await screen.findByText(/waiting for the kiosk to activate/i);

      const callsAtVerify = vi.mocked(adminApi.getDevice).mock.calls.length;
      expect(callsAtVerify).toBeGreaterThanOrEqual(1);

      // Act
      await new Promise((resolve) => setTimeout(resolve, 3400));
      const callsAfterPolling = vi.mocked(adminApi.getDevice).mock.calls.length;
      expect(callsAfterPolling).toBeGreaterThan(callsAtVerify);

      unmount();
      const callsAtUnmount = vi.mocked(adminApi.getDevice).mock.calls.length;
      await new Promise((resolve) => setTimeout(resolve, 3400));

      // Assert
      expect(vi.mocked(adminApi.getDevice).mock.calls.length).toBe(
        callsAtUnmount,
      );
    }, 10_000);
  });

  describe('kiosk URL', (it) => {
    it('shows the full URL built from this page origin, not a bare /kiosk', async () => {
      // Arrange — the wizard is where most operators first meet this
      // instruction, and it read "open /kiosk" with no host, which is not
      // something you can type into the kiosk's browser. The kiosk is served
      // from the same origin as this console, so the page's own location is
      // the answer and needs no configuration to stay right.
      const user = userEvent.setup();
      renderWithProviders(<KioskWizardPage />);

      // Act
      await registerDevice(user);

      // Assert
      const link = screen.getByRole('link', { name: /\/kiosk/ });
      expect(link).toHaveAttribute('href', `${window.location.origin}/kiosk`);
      expect(screen.queryByText(/open \/kiosk and enter/i)).toBeNull();
    });
  });

  describe('re-register', (it) => {
    it('replaces the displayed activation code', async () => {
      // Arrange
      const user = userEvent.setup();
      renderWithProviders(<KioskWizardPage />);
      await registerDevice(user);
      expect(screen.getByText('ABC123')).toBeInTheDocument();
      vi.mocked(adminApi.reregisterDevice).mockResolvedValue({
        activationCode: 'ZZZ999',
        expiry: new Date(Date.now() + 5 * 60_000).toISOString(),
      });

      // Act
      await user.click(
        screen.getByRole('button', { name: /code expired\? re-register/i }),
      );

      // Assert
      await waitFor(() => {
        expect(screen.getByText('ZZZ999')).toBeInTheDocument();
      });
      expect(screen.queryByText('ABC123')).not.toBeInTheDocument();
    });
  });
});
