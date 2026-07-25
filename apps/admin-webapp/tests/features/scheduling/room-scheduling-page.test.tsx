import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, vi } from 'vitest';

import { RoomSchedulingPage } from '#src/features/scheduling/room-scheduling-page';
import { adminApi } from '#src/lib/admin-api';
import { ApiError } from '#src/lib/api-error';

import { renderWithProviders } from '../../utils/render-with-providers';
import { buildRoomDetail, buildSchedule, buildWindow } from './fixtures';

vi.mock('#src/lib/admin-api', () => ({
  adminApi: {
    roomDetail: vi.fn(),
    listSchedules: vi.fn(),
    listAutoWindows: vi.fn(),
    createSchedule: vi.fn(),
    updateSchedule: vi.fn(),
    createAutoWindow: vi.fn(),
    updateAutoWindow: vi.fn(),
    deleteSchedule: vi.fn(),
    deleteAutoWindow: vi.fn(),
    updateRoomScheduleConfig: vi.fn(),
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
});
