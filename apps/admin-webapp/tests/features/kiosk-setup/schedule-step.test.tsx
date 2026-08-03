import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, vi } from 'vitest';

import { ScheduleStep } from '#src/features/kiosk-setup/schedule-step';
import { adminApi } from '#src/lib/admin-api';
import { ApiError } from '#src/lib/api-error';

import { renderWithProviders } from '../../utils/render-with-providers';
import { buildRoomDetail, buildSchedule, buildWindow } from './fixtures';

vi.mock('#src/lib/admin-api', () => ({
  adminApi: {
    listSchedules: vi.fn(),
    listAutoWindows: vi.fn(),
    roomDetail: vi.fn(),
    createSchedule: vi.fn(),
    createAutoWindow: vi.fn(),
    updateRoomScheduleConfig: vi.fn(),
  },
}));

const ROOM_UID = 'room-1';

function mockDefaultLoad(
  roomOverrides: Parameters<typeof buildRoomDetail>[0] = {},
) {
  vi.mocked(adminApi.listSchedules).mockResolvedValue({ items: [] });
  vi.mocked(adminApi.listAutoWindows).mockResolvedValue({ items: [] });
  vi.mocked(adminApi.roomDetail).mockResolvedValue(
    buildRoomDetail(roomOverrides),
  );
}

async function waitForLoad() {
  await waitFor(() => {
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });
}

function renderStep(onCreated = vi.fn()) {
  renderWithProviders(
    <ScheduleStep
      roomUid={ROOM_UID}
      roomTimezone="America/Chicago"
      onCreated={onCreated}
    />,
  );
  return { onCreated };
}

describe('ScheduleStep', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe('roomUid is null', (it) => {
    it('renders the attach-a-room message and issues no requests', () => {
      // Arrange / Act
      renderWithProviders(
        <ScheduleStep
          roomUid={null}
          roomTimezone="America/Chicago"
          onCreated={vi.fn()}
        />,
      );

      // Assert
      expect(
        screen.getByText(/attach this device to a room first/i),
      ).toBeInTheDocument();
      expect(adminApi.listSchedules).not.toHaveBeenCalled();
      expect(adminApi.listAutoWindows).not.toHaveBeenCalled();
      expect(adminApi.roomDetail).not.toHaveBeenCalled();
    });
  });

  describe('mode selection', (it) => {
    it('defaults to "No schedule for now" with neither form mounted', async () => {
      // Arrange
      mockDefaultLoad();

      // Act
      renderStep();
      await waitForLoad();

      // Assert
      expect(
        screen.getByRole('radio', { name: /no schedule for now/i }),
      ).toBeChecked();
      expect(screen.queryByLabelText('Name')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Opens at')).not.toBeInTheDocument();
    });

    it('reveals the schedule form and hides it again for open hours', async () => {
      // Arrange
      mockDefaultLoad();
      renderStep();
      await waitForLoad();
      const user = userEvent.setup();

      // Act
      await user.click(
        screen.getByRole('radio', { name: /recurring schedule/i }),
      );

      // Assert
      expect(screen.getByLabelText('Name')).toBeInTheDocument();
      expect(screen.getByLabelText('Start time')).toBeInTheDocument();

      // Act: switch to open hours
      await user.click(screen.getByRole('radio', { name: /room open hours/i }));

      // Assert
      expect(screen.queryByLabelText('Name')).not.toBeInTheDocument();
      expect(screen.getByLabelText('Opens at')).toBeInTheDocument();
    });
  });

  describe('schedule path', (it) => {
    async function openScheduleForm() {
      mockDefaultLoad();
      renderStep();
      await waitForLoad();
      const user = userEvent.setup();
      await user.click(
        screen.getByRole('radio', { name: /recurring schedule/i }),
      );
      return user;
    }

    it('disables Create schedule until a name is entered', async () => {
      // Arrange
      const user = await openScheduleForm();
      const createButton = screen.getByRole('button', {
        name: /create schedule/i,
      });

      // Assert
      expect(createButton).toBeDisabled();

      // Act
      await user.type(screen.getByLabelText('Name'), 'CS 225 Lecture');

      // Assert
      expect(createButton).toBeEnabled();
    });

    it('rejects a WEEKLY schedule with no days picked, without calling the API', async () => {
      // Arrange
      const user = await openScheduleForm();
      await user.type(screen.getByLabelText('Name'), 'CS 225 Lecture');

      // Act
      await user.click(
        screen.getByRole('button', { name: /create schedule/i }),
      );

      // Assert: shown both as a toast and as a persistent inline error tied
      // to the day-toggle group (WCAG 3.3.1 — not just a transient toast).
      expect(
        await screen.findAllByText(/pick at least one day of the week/i),
      ).toHaveLength(2);
      expect(adminApi.createSchedule).not.toHaveBeenCalled();
    });

    it('creates a schedule with the exact body on the happy path', async () => {
      // Arrange
      const user = await openScheduleForm();
      const created = buildSchedule();
      vi.mocked(adminApi.createSchedule).mockResolvedValue(created);

      await user.type(screen.getByLabelText('Name'), '  CS 225 Lecture  ');
      await user.click(screen.getByRole('button', { name: 'Monday' }));
      await user.click(screen.getByRole('button', { name: 'Wednesday' }));
      await user.click(screen.getByRole('button', { name: 'Friday' }));
      await user.click(screen.getByText('Advanced'));
      const jsonField = screen.getByLabelText(/transcription stream config/i);
      fireEvent.change(jsonField, { target: { value: '{"foo":1}' } });

      // Act
      await user.click(
        screen.getByRole('button', { name: /create schedule/i }),
      );

      // Assert
      await waitFor(() => {
        expect(adminApi.createSchedule).toHaveBeenCalledTimes(1);
      });
      const body = vi.mocked(adminApi.createSchedule).mock.calls[0]![0];
      expect(body).toMatchObject({
        roomUid: ROOM_UID,
        name: 'CS 225 Lecture',
        localStartTime: '09:00',
        localEndTime: '10:00',
        frequency: 'WEEKLY',
        daysOfWeek: ['MON', 'WED', 'FRI'],
        joinCodeScopes: ['SEND_AUDIO', 'RECEIVE_TRANSCRIPTIONS'],
        transcriptionProviderId: 'whisper',
        transcriptionStreamConfig: { foo: 1 },
      });
      expect(body.activeEnd).toBeNull();
      expect(typeof body.activeStart).toBe('string');
    });

    it('sends null daysOfWeek for a ONCE schedule', async () => {
      // Arrange
      const user = await openScheduleForm();
      vi.mocked(adminApi.createSchedule).mockResolvedValue(buildSchedule());
      await user.type(screen.getByLabelText('Name'), 'One-off');
      await user.click(screen.getByText('Advanced'));
      await user.click(screen.getByRole('combobox', { name: /frequency/i }));
      await user.click(screen.getByRole('option', { name: 'ONCE' }));

      // Act
      await user.click(
        screen.getByRole('button', { name: /create schedule/i }),
      );

      // Assert
      await waitFor(() => {
        expect(adminApi.createSchedule).toHaveBeenCalledTimes(1);
      });
      const body = vi.mocked(adminApi.createSchedule).mock.calls[0]![0];
      expect(body.daysOfWeek).toBeNull();
      expect(body.frequency).toBe('ONCE');
    });

    it('shows an inline error for invalid JSON and does not call the API', async () => {
      // Arrange
      const user = await openScheduleForm();
      await user.type(screen.getByLabelText('Name'), 'CS 225 Lecture');
      await user.click(screen.getByRole('button', { name: 'Monday' }));
      await user.click(screen.getByText('Advanced'));
      const jsonField = screen.getByLabelText(/transcription stream config/i);
      fireEvent.change(jsonField, { target: { value: '{not json' } });

      // Act
      await user.click(
        screen.getByRole('button', { name: /create schedule/i }),
      );

      // Assert
      expect(await screen.findByText('Invalid JSON.')).toBeInTheDocument();
      expect(adminApi.createSchedule).not.toHaveBeenCalled();
    });

    it('resets the form, returns to "none", fires onCreated once, and lists the new schedule', async () => {
      // Arrange
      mockDefaultLoad();
      const onCreated = vi.fn();
      const created = buildSchedule({
        name: 'CS 225 Lecture',
        daysOfWeek: ['MON'],
      });
      vi.mocked(adminApi.createSchedule).mockResolvedValue(created);
      renderWithProviders(
        <ScheduleStep
          roomUid={ROOM_UID}
          roomTimezone="America/Chicago"
          onCreated={onCreated}
        />,
      );
      await waitForLoad();
      const user = userEvent.setup();
      await user.click(
        screen.getByRole('radio', { name: /recurring schedule/i }),
      );
      await user.type(screen.getByLabelText('Name'), 'CS 225 Lecture');
      await user.click(screen.getByRole('button', { name: 'Monday' }));

      // Act
      await user.click(
        screen.getByRole('button', { name: /create schedule/i }),
      );

      // Assert
      await waitFor(() => {
        expect(
          screen.getByRole('radio', { name: /no schedule for now/i }),
        ).toBeChecked();
      });
      expect(screen.queryByLabelText('Name')).not.toBeInTheDocument();
      expect(onCreated).toHaveBeenCalledTimes(1);
      expect(
        screen.getByText(/CS 225 Lecture — WEEKLY MON 09:00–09:50/),
      ).toBeInTheDocument();
    });
  });

  describe('open-hours path', (it) => {
    async function openWindowForm(
      roomOverrides: Parameters<typeof buildRoomDetail>[0] = {},
    ) {
      mockDefaultLoad(roomOverrides);
      renderStep();
      await waitForLoad();
      const user = userEvent.setup();
      await user.click(screen.getByRole('radio', { name: /room open hours/i }));
      return user;
    }

    it('defaults to Mon–Fri 08:00–17:00', async () => {
      // Arrange / Act
      await openWindowForm();

      // Assert
      expect(screen.getByLabelText('Opens at')).toHaveValue('08:00');
      expect(screen.getByLabelText('Closes at')).toHaveValue('17:00');
      for (const day of [
        'Monday',
        'Tuesday',
        'Wednesday',
        'Thursday',
        'Friday',
      ]) {
        expect(screen.getByRole('button', { name: day })).toHaveAttribute(
          'aria-pressed',
          'true',
        );
      }
      for (const day of ['Saturday', 'Sunday']) {
        expect(screen.getByRole('button', { name: day })).toHaveAttribute(
          'aria-pressed',
          'false',
        );
      }
    });

    it('shows the checkbox checked when auto-sessions are off, and enables it in that order', async () => {
      // Arrange
      const user = await openWindowForm({ autoSessionEnabled: false });
      const window = buildWindow();
      vi.mocked(adminApi.createAutoWindow).mockResolvedValue(window);
      vi.mocked(adminApi.updateRoomScheduleConfig).mockResolvedValue(
        buildRoomDetail({ autoSessionEnabled: true }).room,
      );
      const checkbox = screen.getByRole('checkbox', {
        name: /enable auto-sessions for this room/i,
      });
      expect(checkbox).toBeChecked();

      // Act
      await user.click(
        screen.getByRole('button', { name: /save open hours/i }),
      );

      // Assert
      await waitFor(() => {
        expect(adminApi.createAutoWindow).toHaveBeenCalledTimes(1);
        expect(adminApi.updateRoomScheduleConfig).toHaveBeenCalledTimes(1);
      });
      expect(adminApi.updateRoomScheduleConfig).toHaveBeenCalledWith({
        roomUid: ROOM_UID,
        autoSessionEnabled: true,
      });
      const windowOrder = vi.mocked(adminApi.createAutoWindow).mock
        .invocationCallOrder[0]!;
      const configOrder = vi.mocked(adminApi.updateRoomScheduleConfig).mock
        .invocationCallOrder[0]!;
      expect(windowOrder).toBeLessThan(configOrder);
    });

    it('shows no checkbox and does not touch the master switch when auto-sessions are already on', async () => {
      // Arrange
      const user = await openWindowForm({ autoSessionEnabled: true });
      vi.mocked(adminApi.createAutoWindow).mockResolvedValue(buildWindow());
      expect(
        screen.getByText(/auto-sessions are already enabled for this room/i),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole('checkbox', {
          name: /enable auto-sessions for this room/i,
        }),
      ).not.toBeInTheDocument();

      // Act
      await user.click(
        screen.getByRole('button', { name: /save open hours/i }),
      );

      // Assert
      await waitFor(() => {
        expect(adminApi.createAutoWindow).toHaveBeenCalledTimes(1);
      });
      expect(adminApi.updateRoomScheduleConfig).not.toHaveBeenCalled();
    });

    it('leaves the master switch untouched and shows the warning caption when unticked', async () => {
      // Arrange
      const user = await openWindowForm({ autoSessionEnabled: false });
      vi.mocked(adminApi.createAutoWindow).mockResolvedValue(buildWindow());
      const checkbox = screen.getByRole('checkbox', {
        name: /enable auto-sessions for this room/i,
      });

      // Act
      await user.click(checkbox);

      // Assert: warning caption visible before saving
      expect(
        screen.getByText(
          /leaving this off saves the hours but produces no sessions/i,
        ),
      ).toBeInTheDocument();

      // Act
      await user.click(
        screen.getByRole('button', { name: /save open hours/i }),
      );

      // Assert
      await waitFor(() => {
        expect(adminApi.createAutoWindow).toHaveBeenCalledTimes(1);
      });
      expect(adminApi.updateRoomScheduleConfig).not.toHaveBeenCalled();
    });

    it('still fires onCreated when createAutoWindow succeeds but the master-switch update fails', async () => {
      // Arrange: documents current behavior per
      // archived-plans/2026-07-23-02-PLAN-Future-todo-wizard-tests.md 1e — the
      // window itself was created, so onCreated firing is treated here as the
      // intended outcome even though the master-switch enable failed.
      mockDefaultLoad({ autoSessionEnabled: false });
      const onCreated = vi.fn();
      renderWithProviders(
        <ScheduleStep
          roomUid={ROOM_UID}
          roomTimezone="America/Chicago"
          onCreated={onCreated}
        />,
      );
      await waitForLoad();
      const user = userEvent.setup();
      await user.click(screen.getByRole('radio', { name: /room open hours/i }));
      vi.mocked(adminApi.createAutoWindow).mockResolvedValue(buildWindow());
      vi.mocked(adminApi.updateRoomScheduleConfig).mockRejectedValue(
        new Error('boom'),
      );

      // Act
      await user.click(
        screen.getByRole('button', { name: /save open hours/i }),
      );

      // Assert
      await waitFor(() => {
        expect(onCreated).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('shared', (it) => {
    it('shows the ADMIN_API_KEY alert instead of a toast on BACKEND_MISCONFIGURATION during load', async () => {
      // Arrange
      vi.mocked(adminApi.listSchedules).mockRejectedValue(
        new ApiError('BACKEND_MISCONFIGURATION', 'nope', 502),
      );
      vi.mocked(adminApi.listAutoWindows).mockResolvedValue({ items: [] });
      vi.mocked(adminApi.roomDetail).mockResolvedValue(buildRoomDetail());

      // Act
      renderStep();
      await waitForLoad();

      // Assert
      expect(
        await screen.findByText(/admin backend misconfiguration/i),
      ).toBeInTheDocument();
    });

    it('renders existing schedules and windows, with the auto-sessions-off suffix only when the room flag is false', async () => {
      // Arrange
      vi.mocked(adminApi.listSchedules).mockResolvedValue({
        items: [buildSchedule()],
      });
      vi.mocked(adminApi.listAutoWindows).mockResolvedValue({
        items: [buildWindow()],
      });
      vi.mocked(adminApi.roomDetail).mockResolvedValue(
        buildRoomDetail({ autoSessionEnabled: false }),
      );

      // Act
      renderStep();
      await waitForLoad();

      // Assert
      expect(
        screen.getByText(/CS 225 Lecture — WEEKLY MON, WED, FRI 09:00–09:50/),
      ).toBeInTheDocument();
      expect(
        screen.getByText(
          /Open hours MON, TUE, WED, THU, FRI 08:00–17:00 \(auto-sessions are off for this room\)/,
        ),
      ).toBeInTheDocument();
    });

    it('omits the auto-sessions-off suffix when the room flag is true', async () => {
      // Arrange
      vi.mocked(adminApi.listSchedules).mockResolvedValue({ items: [] });
      vi.mocked(adminApi.listAutoWindows).mockResolvedValue({
        items: [buildWindow()],
      });
      vi.mocked(adminApi.roomDetail).mockResolvedValue(
        buildRoomDetail({ autoSessionEnabled: true }),
      );

      // Act
      renderStep();
      await waitForLoad();

      // Assert
      const windowLine = screen.getByText(
        /Open hours MON, TUE, WED, THU, FRI 08:00–17:00/,
      );
      expect(windowLine.textContent).not.toMatch(/auto-sessions are off/);
    });
  });
});
