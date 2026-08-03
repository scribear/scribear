import type { ReactElement } from 'react';

import { fireEvent, screen, waitFor } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, vi } from 'vitest';

import { DEMO_ROOM_UID } from '@scribear/session-manager-schema';

import { RoomDetailPage } from '#src/features/rooms/room-detail-page';
import { adminApi } from '#src/lib/admin-api';
import { ApiError } from '#src/lib/api-error';
import { browserTimeZone, formatInTimeZone } from '#src/lib/timezone';

import { renderWithProviders } from '../../utils/render-with-providers';
import { buildDevice, buildRoomDetail, buildSession } from './fixtures';

vi.mock('#src/lib/admin-api', () => ({
  adminApi: {
    roomDetail: vi.fn(),
    getActiveSession: vi.fn(),
    endSessionEarly: vi.fn(),
  },
}));

const ROOM_UID = 'room-1';

function renderPage(
  ui: ReactElement = <RoomDetailPage />,
  roomUid: string = ROOM_UID,
) {
  return renderWithProviders(
    <Routes>
      <Route path="/rooms/:roomUid" element={ui} />
    </Routes>,
    { route: `/rooms/${roomUid}` },
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
    // Default: no active session. Individual tests override as needed.
    vi.mocked(adminApi.getActiveSession).mockResolvedValue(null);
    vi.mocked(adminApi.endSessionEarly).mockResolvedValue(null);
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

  describe('active session card', (it) => {
    // The card exists to explain an ANOTHER_SESSION_ACTIVE conflict, so the
    // one answer it must never give is a confident "nothing is running" when
    // it does not actually know. `useAsyncData` reports `data: null` both
    // before the first success and after a failure, so "no active session"
    // has to be distinguished from "not yet known".
    it('does not claim the room is idle while the lookup is still in flight', async () => {
      // Arrange
      vi.mocked(adminApi.roomDetail).mockResolvedValue(buildRoomDetail());
      vi.mocked(adminApi.getActiveSession).mockReturnValue(
        new Promise(() => {
          /* never resolves */
        }),
      );

      // Act
      renderPage();
      await screen.findByText('Active session');

      // Assert
      expect(
        screen.queryByText(/no session is currently active/i),
      ).not.toBeInTheDocument();
      expect(
        screen.getByText(/checking for an active session/i),
      ).toBeInTheDocument();
    });

    it('does not claim the room is idle when the lookup failed', async () => {
      // Arrange
      vi.mocked(adminApi.roomDetail).mockResolvedValue(buildRoomDetail());
      vi.mocked(adminApi.getActiveSession).mockRejectedValue(
        new ApiError('NETWORK', 'Could not reach the admin server.', 0),
      );

      // Act
      renderPage();
      await waitForLoad();

      // Assert
      expect(
        screen.queryByText(/no session is currently active/i),
      ).not.toBeInTheDocument();
      expect(
        screen.getByText(/could not check for an active session/i),
      ).toBeInTheDocument();
    });

    it('reports an idle room only once the lookup succeeded with no session', async () => {
      // Arrange
      vi.mocked(adminApi.roomDetail).mockResolvedValue(buildRoomDetail());
      vi.mocked(adminApi.getActiveSession).mockResolvedValue(null);

      // Act
      renderPage();
      await waitForLoad();

      // Assert
      expect(
        await screen.findByText(/no session is currently active/i),
      ).toBeInTheDocument();
    });

    it('renders the active session with an End early action', async () => {
      // Arrange
      vi.mocked(adminApi.roomDetail).mockResolvedValue(buildRoomDetail());
      vi.mocked(adminApi.getActiveSession).mockResolvedValue(
        buildSession({ name: 'Morning lecture', type: 'ON_DEMAND' }),
      );

      // Act
      renderPage();
      await waitForLoad();

      // Assert
      expect(await screen.findByText('Morning lecture')).toBeInTheDocument();
      expect(screen.getByText('ON_DEMAND')).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: 'End early' }),
      ).toBeInTheDocument();
      expect(
        screen.queryByText(/no session is currently active/i),
      ).not.toBeInTheDocument();
    });

    it("prints session times in the room's timezone, not the browser's", async () => {
      // Arrange - the page declares the room's zone in its TimezoneNote, so
      // every timestamp under it has to agree; printing the browser's reading
      // of the same instant would make the note a lie and mislead anyone
      // administering a room from elsewhere. The room zone is chosen against
      // whatever zone this runner is in, so the assertion means the same
      // thing on a developer's machine and in CI.
      const browserZone = browserTimeZone();
      const roomZone =
        browserZone === 'Asia/Tokyo' ? 'Pacific/Honolulu' : 'Asia/Tokyo';
      const start = '2026-07-01T15:30:00.000Z';
      vi.mocked(adminApi.roomDetail).mockResolvedValue(
        buildRoomDetail({ room: { timezone: roomZone } }),
      );
      vi.mocked(adminApi.getActiveSession).mockResolvedValue(
        buildSession({ effectiveStart: start, effectiveEnd: null }),
      );

      // Act
      const { container } = renderPage();
      await waitForLoad();
      await screen.findByText(/open-ended/i);

      // Assert - the room's reading is printed, and the browser's is not.
      expect(container.textContent).toContain(
        formatInTimeZone(start, roomZone),
      );
      expect(container.textContent).not.toContain(
        formatInTimeZone(start, browserZone),
      );
    });

    it('hides End early for the demo room, whose fixture session is permanent', async () => {
      // Arrange
      vi.mocked(adminApi.roomDetail).mockResolvedValue(
        buildRoomDetail({ room: { uid: DEMO_ROOM_UID } }),
      );
      vi.mocked(adminApi.getActiveSession).mockResolvedValue(
        buildSession({ roomUid: DEMO_ROOM_UID }),
      );

      // Act
      renderPage(<RoomDetailPage />, DEMO_ROOM_UID);
      await waitForLoad();

      // Assert - viewing stays available, ending does not.
      expect(
        await screen.findByRole('button', { name: 'View session' }),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: 'End early' }),
      ).not.toBeInTheDocument();
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
    it('reserves "Room not found." for an actual 404', async () => {
      // Arrange
      vi.mocked(adminApi.roomDetail).mockRejectedValue(
        new ApiError('NOT_FOUND', 'No such room.', 404),
      );

      // Act
      renderPage();
      await waitForLoad();

      // Assert
      expect(screen.getByText('Room not found.')).toBeInTheDocument();
    });

    it('does not claim the room is missing when the load merely failed', async () => {
      // Arrange - the §5 bug one level up from the lists: every failure used
      // to render "Room not found.", i.e. a statement about the deployment.
      vi.mocked(adminApi.roomDetail).mockRejectedValue(
        new Error('network down'),
      );

      // Act
      renderPage();
      await waitForLoad();

      // Assert
      expect(
        await screen.findByText('Could not load this room.'),
      ).toBeInTheDocument();
      expect(screen.queryByText('Room not found.')).not.toBeInTheDocument();
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

  describe('demo caption room', (it) => {
    it('disables the device controls and explains that there is no audio path', async () => {
      // Arrange - the demo room's captions come from a fixture, so the Session
      // Manager refuses these two mutations (409). Disabling them here is what
      // stops an operator from discovering the rule by hitting an error.
      vi.mocked(adminApi.roomDetail).mockResolvedValue(
        buildRoomDetail({
          room: { uid: DEMO_ROOM_UID, name: 'Demo — Alice in Wonderland' },
          devices: [
            buildDevice({
              uid: 'device-1',
              name: 'Member',
              roomUid: DEMO_ROOM_UID,
              isSource: false,
            }),
          ],
        }),
      );

      // Act
      renderPage(<RoomDetailPage />, DEMO_ROOM_UID);
      await waitForLoad();

      // Assert
      expect(screen.getByRole('button', { name: 'Add device' })).toBeDisabled();
      expect(
        screen.getByRole('button', { name: 'Set as source' }),
      ).toBeDisabled();
      expect(screen.getByText(/there is no audio path/i)).toBeInTheDocument();
      // Detaching stays available: it is the only way to clean up a device
      // attached before the refusal existed.
      expect(screen.getByRole('button', { name: 'Remove' })).toBeEnabled();
    });

    it('leaves the same controls enabled for an ordinary room', async () => {
      // Arrange - the case that matters most: a guard keyed off the wrong thing
      // would disable device management for every real room.
      vi.mocked(adminApi.roomDetail).mockResolvedValue(
        buildRoomDetail({
          room: { uid: ROOM_UID, name: 'Room 101' },
          devices: [
            buildDevice({
              uid: 'device-1',
              name: 'Kiosk 1',
              roomUid: ROOM_UID,
              isSource: false,
            }),
          ],
        }),
      );

      // Act
      renderPage();
      await waitForLoad();

      // Assert
      expect(screen.getByRole('button', { name: 'Add device' })).toBeEnabled();
      expect(
        screen.getByRole('button', { name: 'Set as source' }),
      ).toBeEnabled();
      expect(
        screen.queryByText(/there is no audio path/i),
      ).not.toBeInTheDocument();
    });
  });

  describe('Presence', (it) => {
    // §4.5: room-detail-page previously showed only Active/Pending
    // (activation state) in the devices table, with no online/offline or
    // lastSeenAt — "is the kiosk plugged in?" was unanswerable here. These pin
    // that presence now renders alongside, not instead of, activation state.
    it('shows Online for a device currently connected', async () => {
      // Arrange
      vi.mocked(adminApi.roomDetail).mockResolvedValue(
        buildRoomDetail({
          room: { uid: ROOM_UID },
          devices: [
            buildDevice({
              uid: 'device-1',
              name: 'Kiosk 1',
              online: true,
              lastSeenAt: '2026-01-01T12:00:00.000Z',
            }),
          ],
        }),
      );

      // Act
      renderPage();
      await waitForLoad();

      // Assert
      expect(screen.getByText('Online')).toBeInTheDocument();
    });

    it('flags an activated device that has gone offline as a real problem, distinct from a merely-pending one', async () => {
      // Arrange: Active + Offline is exactly the "silent room" case — the
      // device was set up and is expected to be reachable, so its absence
      // needs a `warning`, not the neutral color an unactivated device gets.
      vi.mocked(adminApi.roomDetail).mockResolvedValue(
        buildRoomDetail({
          room: { uid: ROOM_UID },
          devices: [
            buildDevice({
              uid: 'device-1',
              name: 'Kiosk 1',
              active: true,
              online: false,
              lastSeenAt: '2026-01-01T08:00:00.000Z',
            }),
          ],
        }),
      );

      // Act
      renderPage();
      await waitForLoad();

      // Assert
      expect(screen.getByText('Offline').closest('.MuiChip-root')).toHaveClass(
        'MuiChip-colorWarning',
      );
      // Activation state is unaffected — both facts are visible at once.
      expect(screen.getByText('Active')).toBeInTheDocument();
    });

    it('does not flag a not-yet-activated device that has never connected as a problem', async () => {
      // Arrange
      vi.mocked(adminApi.roomDetail).mockResolvedValue(
        buildRoomDetail({
          room: { uid: ROOM_UID },
          devices: [
            buildDevice({
              uid: 'device-1',
              name: 'Kiosk 1',
              active: false,
              online: false,
              lastSeenAt: null,
            }),
          ],
        }),
      );

      // Act
      renderPage();
      await waitForLoad();

      // Assert
      expect(screen.getByText('Offline').closest('.MuiChip-root')).toHaveClass(
        'MuiChip-colorDefault',
      );
      expect(screen.getByText('Pending')).toBeInTheDocument();
    });

    it('shows the last-seen time on hover, distinguishing "seen before" from "never seen"', async () => {
      // Arrange
      vi.mocked(adminApi.roomDetail).mockResolvedValue(
        buildRoomDetail({
          room: { uid: ROOM_UID },
          devices: [
            buildDevice({
              uid: 'device-1',
              name: 'Kiosk 1',
              active: true,
              online: false,
              lastSeenAt: '2026-01-01T08:00:00.000Z',
            }),
          ],
        }),
      );
      renderPage();
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
});
