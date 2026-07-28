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
