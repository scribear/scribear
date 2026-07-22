import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { Session } from '@scribear/session-manager-schema';

import {
  type CalendarColumn,
  SessionCalendarGrid,
} from '#src/features/sessions/session-calendar-grid';

// Noon local time, constructed from local (not UTC) components, so the
// block always falls inside the grid's default [7, 22] hour window
// regardless of which time zone the test runs in.
const NOON_LOCAL = new Date(2026, 5, 3, 12, 0, 0).toISOString();
const ONE_PM_LOCAL = new Date(2026, 5, 3, 13, 0, 0).toISOString();

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    uid: 'sess-1',
    roomUid: 'room-a',
    name: 'Standup',
    type: 'SCHEDULED',
    scheduledSessionUid: 'sched-1',
    scheduledStartTime: NOON_LOCAL,
    scheduledEndTime: ONE_PM_LOCAL,
    startOverride: null,
    endOverride: null,
    canceledAt: null,
    effectiveStart: NOON_LOCAL,
    effectiveEnd: ONE_PM_LOCAL,
    joinCodeScopes: [],
    transcriptionProviderId: 'whisper',
    transcriptionStreamConfig: {},
    sessionConfigVersion: 1,
    createdAt: '2026-06-01T00:00:00.000Z',
    ...overrides,
  };
}

const COLUMNS: CalendarColumn[] = [
  { key: 'room-a', label: 'Room A' },
  { key: 'room-b', label: 'Room B' },
];

describe('SessionCalendarGrid', () => {
  it('renders each session into its mapped column', () => {
    const sessions = [
      makeSession({ uid: 'sess-a', name: 'In room A', roomUid: 'room-a' }),
      makeSession({ uid: 'sess-b', name: 'In room B', roomUid: 'room-b' }),
    ];

    render(
      <SessionCalendarGrid
        columns={COLUMNS}
        sessions={sessions}
        getColumnKeyForSession={(s) => s.roomUid}
        onSessionClick={() => {
          /* noop */
        }}
        showUuids={false}
      />,
    );

    expect(screen.getByText('Room A')).toBeInTheDocument();
    expect(screen.getByText('Room B')).toBeInTheDocument();
    expect(screen.getByText('In room A')).toBeInTheDocument();
    expect(screen.getByText('In room B')).toBeInTheDocument();
  });

  it('calls onSessionClick when a session block is clicked', () => {
    const onSessionClick = vi.fn();
    const session = makeSession({ name: 'Clickable' });

    render(
      <SessionCalendarGrid
        columns={[{ key: 'room-a', label: 'Room A' }]}
        sessions={[session]}
        getColumnKeyForSession={(s) => s.roomUid}
        onSessionClick={onSessionClick}
        showUuids={false}
      />,
    );

    fireEvent.click(screen.getByText('Clickable'));
    expect(onSessionClick).toHaveBeenCalledWith(session);
  });

  it('shows a "Canceled" label for a canceled session', () => {
    const session = makeSession({
      name: 'Canceled Session',
      canceledAt: '2026-06-02T00:00:00.000Z',
    });

    render(
      <SessionCalendarGrid
        columns={[{ key: 'room-a', label: 'Room A' }]}
        sessions={[session]}
        getColumnKeyForSession={(s) => s.roomUid}
        onSessionClick={() => {
          /* noop */
        }}
        showUuids={false}
      />,
    );

    expect(screen.getByText('Canceled')).toBeInTheDocument();
  });

  it('shows the session uid when showUuids is true', () => {
    const session = makeSession({ uid: 'sess-visible-uid' });

    render(
      <SessionCalendarGrid
        columns={[{ key: 'room-a', label: 'Room A' }]}
        sessions={[session]}
        getColumnKeyForSession={(s) => s.roomUid}
        onSessionClick={() => {
          /* noop */
        }}
        showUuids
      />,
    );

    expect(screen.getByText('sess-visible-uid')).toBeInTheDocument();
  });
});
