import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Room } from '@scribear/session-manager-schema';

import { RoomPicker } from '#src/features/sessions/room-picker';
import { adminApi } from '#src/lib/admin-api';

vi.mock('#src/lib/admin-api', () => ({
  adminApi: { listRooms: vi.fn() },
}));

function makeRoom(overrides: Partial<Room> = {}): Room {
  return {
    uid: 'room-1',
    name: 'Room 1',
    timezone: 'America/Chicago',
    autoSessionEnabled: false,
    roomScheduleVersion: 1,
    createdAt: '2026-06-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('RoomPicker', () => {
  beforeEach(() => {
    vi.mocked(adminApi.listRooms).mockResolvedValue({
      items: [makeRoom()],
      nextCursor: null,
    });
  });

  it('searches rooms as the user types', async () => {
    render(<RoomPicker selected={[]} onChange={() => undefined} />);

    const input = screen.getByRole('combobox', { name: 'Rooms' });
    fireEvent.change(input, { target: { value: 'Conf' } });

    await waitFor(() => {
      expect(adminApi.listRooms).toHaveBeenCalledWith({
        search: 'Conf',
        limit: 25,
      });
    });
  });

  it('reports a failed search instead of showing "No rooms match."', async () => {
    // Arrange - the catch used to be silent, so a dead admin server rendered
    // as "this deployment has no rooms matching that" (PLAN-VisibleErrors §5).
    vi.mocked(adminApi.listRooms).mockRejectedValue(new Error('backend down'));
    render(<RoomPicker selected={[]} onChange={() => undefined} />);

    // Act
    const input = screen.getByRole('combobox', { name: 'Rooms' });
    fireEvent.change(input, { target: { value: 'Conf' } });

    // Assert - said twice on purpose: in the field's helper text and in place
    // of the "No rooms match." empty-list wording inside the open popup.
    expect(
      await screen.findAllByText(/could not search rooms/i),
    ).not.toHaveLength(0);
    expect(screen.queryByText('No rooms match.')).not.toBeInTheDocument();
  });

  it('clears the failure notice once a later search succeeds', async () => {
    // Arrange
    vi.mocked(adminApi.listRooms).mockRejectedValueOnce(
      new Error('backend down'),
    );
    render(<RoomPicker selected={[]} onChange={() => undefined} />);
    await screen.findAllByText(/could not search rooms/i);

    // Act
    fireEvent.change(screen.getByRole('combobox', { name: 'Rooms' }), {
      target: { value: 'Room' },
    });

    // Assert
    await waitFor(() => {
      expect(screen.queryAllByText(/could not search rooms/i)).toHaveLength(0);
    });
  });

  it('calls onChange when an option is selected', async () => {
    const onChange = vi.fn();
    render(<RoomPicker selected={[]} onChange={onChange} />);

    const input = screen.getByRole('combobox', { name: 'Rooms' });
    fireEvent.change(input, { target: { value: 'Room' } });

    const option = await screen.findByText('Room 1');
    fireEvent.click(option);

    expect(onChange).toHaveBeenCalledWith([makeRoom()]);
  });
});
