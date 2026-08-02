import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, vi } from 'vitest';

import { RoomSchedulingPage } from '#src/features/scheduling/room-scheduling-page';
import { adminApi } from '#src/lib/admin-api';
import { ApiError } from '#src/lib/api-error';

import { renderWithProviders } from '../../utils/render-with-providers';
import {
  buildRoomDetail,
  buildSchedule,
  buildSession,
  buildWindow,
} from './fixtures';

vi.mock('#src/lib/admin-api', () => ({
  adminApi: {
    roomDetail: vi.fn(),
    listSchedules: vi.fn(),
    listAutoWindows: vi.fn(),
    listSessions: vi.fn(),
    createSchedule: vi.fn(),
    updateSchedule: vi.fn(),
    createAutoWindow: vi.fn(),
    updateAutoWindow: vi.fn(),
    deleteSchedule: vi.fn(),
    deleteAutoWindow: vi.fn(),
    updateRoomScheduleConfig: vi.fn(),
    createOnDemandSession: vi.fn(),
  },
}));

const ROOM_UID = 'room-1';

function mockDefaultLoad(
  options: {
    schedules?: ReturnType<typeof buildSchedule>[];
    windows?: ReturnType<typeof buildWindow>[];
    roomOverrides?: Parameters<typeof buildRoomDetail>[0];
  } = {},
) {
  const { schedules = [], windows = [], roomOverrides = {} } = options;
  vi.mocked(adminApi.roomDetail).mockResolvedValue(
    buildRoomDetail(roomOverrides),
  );
  vi.mocked(adminApi.listSchedules).mockResolvedValue({ items: schedules });
  vi.mocked(adminApi.listAutoWindows).mockResolvedValue({ items: windows });
  vi.mocked(adminApi.listSessions).mockResolvedValue({ items: [] });
}

async function waitForLoad() {
  await waitFor(() => {
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });
}

function renderPage() {
  renderWithProviders(
    <Routes>
      <Route
        path="/rooms/:roomUid/scheduling"
        element={<RoomSchedulingPage />}
      />
    </Routes>,
    { route: `/rooms/${ROOM_UID}/scheduling` },
  );
}

/** Finds the table row containing `text` and returns the "Edit" button
 * inside it, disambiguating the schedules table from the windows table
 * (both render an "Edit"/"Delete" button pair). */
function editButtonForRow(text: string) {
  const row = screen.getByText(text).closest('tr');
  if (row === null) throw new Error(`no row found for "${text}"`);
  return within(row).getByRole('button', { name: 'Edit' });
}

/** Opens a MultiSelectField's dropdown and toggles one option, then closes
 * it with Escape (MUI's multi-select keeps the listbox open across clicks). */
async function toggleMultiSelectOption(
  user: ReturnType<typeof userEvent.setup>,
  fieldLabel: string,
  optionName: string,
) {
  await user.click(screen.getByLabelText(fieldLabel));
  await user.click(
    await screen.findByRole('option', { name: new RegExp(optionName) }),
  );
  await user.keyboard('{Escape}');
}

describe('RoomSchedulingPage', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe('ScheduleDialog edit-mode diffing', (it) => {
    it('sends only the fields the user actually changed', async () => {
      // Arrange
      const schedule = buildSchedule({
        uid: 'schedule-1',
        name: 'CS 225 Lecture',
        localStartTime: '09:00:00',
        localEndTime: '09:50:00',
      });
      mockDefaultLoad({ schedules: [schedule] });
      renderPage();
      await waitForLoad();
      const user = userEvent.setup();
      await user.click(editButtonForRow('CS 225 Lecture'));

      const nameField = await screen.findByLabelText('Name');
      expect(nameField).toHaveValue('CS 225 Lecture');
      await user.clear(nameField);
      await user.type(nameField, 'CS 225 Lecture (renamed)');
      fireEvent.change(screen.getByLabelText('Local end time'), {
        target: { value: '10:30' },
      });

      const created = buildSchedule();
      vi.mocked(adminApi.updateSchedule).mockResolvedValue(created);

      // Act
      await user.click(screen.getByRole('button', { name: 'Save' }));

      // Assert
      await waitFor(() => {
        expect(adminApi.updateSchedule).toHaveBeenCalledTimes(1);
      });
      const body = vi.mocked(adminApi.updateSchedule).mock.calls[0]![0];
      expect(body).toEqual({
        scheduleUid: 'schedule-1',
        name: 'CS 225 Lecture (renamed)',
        localEndTime: '10:30',
      });
    });

    it('sends only {scheduleUid} when nothing was changed before Save', async () => {
      // Arrange: locks in current behavior — handleSubmit has no
      // "anything actually changed?" guard, so an untouched edit still
      // issues an update call with an effectively-empty diff.
      const schedule = buildSchedule({
        uid: 'schedule-1',
        name: 'CS 225 Lecture',
      });
      mockDefaultLoad({ schedules: [schedule] });
      renderPage();
      await waitForLoad();
      const user = userEvent.setup();
      await user.click(editButtonForRow('CS 225 Lecture'));
      await screen.findByLabelText('Name');
      vi.mocked(adminApi.updateSchedule).mockResolvedValue(schedule);

      // Act
      await user.click(screen.getByRole('button', { name: 'Save' }));

      // Assert
      await waitFor(() => {
        expect(adminApi.updateSchedule).toHaveBeenCalledTimes(1);
      });
      expect(adminApi.updateSchedule).toHaveBeenCalledWith({
        scheduleUid: 'schedule-1',
      });
    });
  });

  describe('ScheduleDialog create-mode', (it) => {
    it('sends a full body, not a partial diff', async () => {
      // Arrange
      mockDefaultLoad();
      renderPage();
      await waitForLoad();
      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: /new schedule/i }));

      await user.type(await screen.findByLabelText('Name'), 'New Schedule');
      fireEvent.change(screen.getByLabelText('Active start'), {
        target: { value: '2030-01-01T09:00' },
      });
      vi.mocked(adminApi.createSchedule).mockResolvedValue(buildSchedule());

      // Act
      await user.click(screen.getByRole('button', { name: 'Save' }));

      // Assert
      await waitFor(() => {
        expect(adminApi.createSchedule).toHaveBeenCalledTimes(1);
      });
      const body = vi.mocked(adminApi.createSchedule).mock.calls[0]![0];
      expect(body).toEqual({
        roomUid: ROOM_UID,
        name: 'New Schedule',
        activeStart: new Date('2030-01-01T09:00').toISOString(),
        activeEnd: null,
        localStartTime: '09:00',
        localEndTime: '10:00',
        frequency: 'ONCE',
        daysOfWeek: null,
        joinCodeScopes: ['SEND_AUDIO', 'RECEIVE_TRANSCRIPTIONS'],
        transcriptionProviderId: 'whisper',
        transcriptionStreamConfig: {},
      });
    });
  });

  describe('AutoWindowDialog edit-mode diffing', (it) => {
    it('sends only the fields the user actually changed', async () => {
      // Arrange
      const w = buildWindow({
        uid: 'window-1',
        localStartTime: '08:00:00',
        localEndTime: '17:00:00',
        transcriptionProviderId: 'whisper',
      });
      mockDefaultLoad({ windows: [w] });
      renderPage();
      await waitForLoad();
      const user = userEvent.setup();
      await user.click(editButtonForRow('MON, TUE, WED, THU, FRI'));

      fireEvent.change(await screen.findByLabelText('Local start time'), {
        target: { value: '07:00' },
      });
      const providerField = screen.getByLabelText('Transcription provider ID');
      await user.clear(providerField);
      await user.type(providerField, 'other-provider');

      vi.mocked(adminApi.updateAutoWindow).mockResolvedValue(w);

      // Act
      await user.click(screen.getByRole('button', { name: 'Save' }));

      // Assert
      await waitFor(() => {
        expect(adminApi.updateAutoWindow).toHaveBeenCalledTimes(1);
      });
      const body = vi.mocked(adminApi.updateAutoWindow).mock.calls[0]![0];
      expect(body).toEqual({
        windowUid: 'window-1',
        localStartTime: '07:00',
        transcriptionProviderId: 'other-provider',
      });
    });
  });

  describe('AutoWindowDialog create-mode', (it) => {
    it('sends a full body, not a partial diff', async () => {
      // Arrange
      mockDefaultLoad();
      renderPage();
      await waitForLoad();
      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: /new window/i }));
      await screen.findByLabelText('Local start time');

      // The window form starts with no days picked, so at least one must be
      // chosen for Save to pass validation.
      await toggleMultiSelectOption(user, 'Days of week', 'MON');
      fireEvent.change(screen.getByLabelText('Active start'), {
        target: { value: '2030-01-01T09:00' },
      });
      vi.mocked(adminApi.createAutoWindow).mockResolvedValue(buildWindow());

      // Act
      await user.click(screen.getByRole('button', { name: 'Save' }));

      // Assert
      await waitFor(() => {
        expect(adminApi.createAutoWindow).toHaveBeenCalledTimes(1);
      });
      const body = vi.mocked(adminApi.createAutoWindow).mock.calls[0]![0];
      expect(body).toEqual({
        roomUid: ROOM_UID,
        localStartTime: '09:00',
        localEndTime: '10:00',
        daysOfWeek: ['MON'],
        activeStart: new Date('2030-01-01T09:00').toISOString(),
        activeEnd: null,
        joinCodeScopes: ['SEND_AUDIO', 'RECEIVE_TRANSCRIPTIONS'],
        transcriptionProviderId: 'whisper',
        transcriptionStreamConfig: {},
      });
    });
  });

  // The two clocks a scheduling dialog uses at once: "Local start/end time"
  // is resolved server-side in the *room's* zone, "Active start" client-side
  // in the browser's. Both are labeled so an operator administering a room in
  // another timezone can see which is which — a mismatch is otherwise silent,
  // since every value is individually valid.
  describe('local-time fields name the room timezone', (it) => {
    it('labels the window dialog with the room name and IANA zone', async () => {
      // Arrange
      mockDefaultLoad({
        roomOverrides: { name: 'Siebel 1404', timezone: 'Europe/London' },
      });
      renderPage();
      await waitForLoad();
      const user = userEvent.setup();

      // Act
      await user.click(screen.getByRole('button', { name: /new window/i }));
      await screen.findByLabelText('Local start time');

      // Assert
      expect(
        screen.getByText(
          "Interpreted in Siebel 1404's timezone (Europe/London), not your browser's.",
        ),
      ).toBeInTheDocument();
      expect(
        screen.getByText(
          "Must be in the future. Interpreted in your browser's local time zone.",
        ),
      ).toBeInTheDocument();
    });

    it('labels the schedule dialog with the room name and IANA zone', async () => {
      // Arrange
      mockDefaultLoad({
        roomOverrides: { name: 'Siebel 1404', timezone: 'Europe/London' },
      });
      renderPage();
      await waitForLoad();
      const user = userEvent.setup();

      // Act
      await user.click(screen.getByRole('button', { name: /new schedule/i }));
      await screen.findByLabelText('Local start time');

      // Assert
      expect(
        screen.getByText(
          "Interpreted in Siebel 1404's timezone (Europe/London), not your browser's.",
        ),
      ).toBeInTheDocument();
    });

    it('points both local-time inputs at that caption for screen readers', async () => {
      // Arrange
      mockDefaultLoad({
        roomOverrides: { name: 'Siebel 1404', timezone: 'Europe/London' },
      });
      renderPage();
      await waitForLoad();
      const user = userEvent.setup();

      // Act
      await user.click(screen.getByRole('button', { name: /new window/i }));
      const start = await screen.findByLabelText('Local start time');

      // Assert
      const helperId = start.getAttribute('aria-describedby');
      expect(helperId).not.toBeNull();
      expect(
        screen
          .getByLabelText('Local end time')
          .getAttribute('aria-describedby'),
      ).toBe(helperId);
      expect(document.getElementById(helperId ?? '')).toHaveTextContent(
        "Interpreted in Siebel 1404's timezone (Europe/London), not your browser's.",
      );
    });
  });

  describe('BACKEND_MISCONFIGURATION handling', (it) => {
    it('shows the in-dialog alert instead of a toast when updating a schedule hits BACKEND_MISCONFIGURATION', async () => {
      // Arrange
      const schedule = buildSchedule({
        uid: 'schedule-1',
        name: 'CS 225 Lecture',
      });
      mockDefaultLoad({ schedules: [schedule] });
      renderPage();
      await waitForLoad();
      const user = userEvent.setup();
      await user.click(editButtonForRow('CS 225 Lecture'));
      await screen.findByLabelText('Name');
      vi.mocked(adminApi.updateSchedule).mockRejectedValue(
        new ApiError('BACKEND_MISCONFIGURATION', 'nope', 502),
      );

      // Act
      await user.click(screen.getByRole('button', { name: 'Save' }));

      // Assert
      expect(
        await screen.findByText(
          /admin backend misconfiguration.*ADMIN_API_KEY/i,
        ),
      ).toBeInTheDocument();
      expect(
        screen.queryByText(/failed to update schedule/i),
      ).not.toBeInTheDocument();
    });
  });

  describe('sessions table', (it) => {
    /** The Sessions table body, keyed off its own column header. */
    function sessionsTable() {
      const header = screen.getByRole('columnheader', {
        name: 'Effective start',
      });
      const table = header.closest('table');
      if (table === null) throw new Error('no sessions table found');
      return table;
    }

    it('lists on-demand sessions, which have no parent schedule', async () => {
      // Arrange - the gap this page had: a live ON_DEMAND row is invisible to
      // listSchedules, so it never appeared before.
      mockDefaultLoad();
      vi.mocked(adminApi.listSessions).mockResolvedValue({
        items: [buildSession({ name: 'Ad-hoc office hours' })],
      });

      // Act
      renderPage();
      await waitForLoad();

      // Assert
      expect(
        within(sessionsTable()).getByText('Ad-hoc office hours'),
      ).toBeInTheDocument();
      expect(
        within(sessionsTable()).getByText('ON_DEMAND'),
      ).toBeInTheDocument();
    });

    it('marks an open-ended session that has already started as active', async () => {
      // Arrange
      mockDefaultLoad();
      vi.mocked(adminApi.listSessions).mockResolvedValue({
        items: [
          buildSession({
            name: 'Running now',
            effectiveStart: '2020-01-01T00:00:00.000Z',
            effectiveEnd: null,
          }),
        ],
      });

      // Act
      renderPage();
      await waitForLoad();

      // Assert
      const table = within(sessionsTable());
      expect(table.getByText('active')).toBeInTheDocument();
      expect(table.getByText('Open-ended')).toBeInTheDocument();
    });

    // `useAsyncData` raises `loading` on every re-fetch, so gating the table
    // body on it directly would blank the rows to a spinner once per poll,
    // every SESSION_POLL_MS, for as long as the page is open.
    it('keeps the rows visible while a background poll is in flight', async () => {
      // Arrange
      mockDefaultLoad();
      vi.mocked(adminApi.listSessions)
        .mockResolvedValueOnce({
          items: [buildSession({ name: 'Still here' })],
        })
        .mockReturnValueOnce(
          new Promise(() => {
            /* the poll's refetch never settles */
          }),
        );
      renderPage();
      await waitForLoad();
      expect(
        within(sessionsTable()).getByText('Still here'),
      ).toBeInTheDocument();

      // Act - the visibility handler is the poll's other trigger; jsdom
      // reports the document as visible, so this runs the same code path.
      fireEvent(document, new Event('visibilitychange'));

      // Assert - the refetch is in flight and the row has not been replaced.
      await waitFor(() => {
        expect(vi.mocked(adminApi.listSessions)).toHaveBeenCalledTimes(2);
      });
      expect(
        within(sessionsTable()).getByText('Still here'),
      ).toBeInTheDocument();
      expect(
        within(sessionsTable()).queryByRole('progressbar'),
      ).not.toBeInTheDocument();
    });
  });
});
