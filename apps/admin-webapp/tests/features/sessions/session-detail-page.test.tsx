import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Session } from '@scribear/session-manager-schema';

import { SessionDetailPage } from '#src/features/sessions/session-detail-page';
import { adminApi } from '#src/lib/admin-api';
import { ApiError } from '#src/lib/api-error';
import { ToastProvider } from '#src/lib/toast-provider';

vi.mock('#src/lib/admin-api', () => ({
  adminApi: {
    getSession: vi.fn(),
    startSessionEarly: vi.fn(),
    endSessionEarly: vi.fn(),
    cancelSession: vi.fn(),
    uncancelSession: vi.fn(),
  },
}));

const HOUR_MS = 60 * 60 * 1000;

function makeSession(overrides: Partial<Session> = {}): Session {
  const start = new Date(Date.now() + HOUR_MS).toISOString();
  const end = new Date(Date.now() + 2 * HOUR_MS).toISOString();
  return {
    uid: 'sess-1',
    roomUid: 'room-1',
    name: 'Test Session',
    type: 'SCHEDULED',
    scheduledSessionUid: 'sched-1',
    scheduledStartTime: start,
    scheduledEndTime: end,
    startOverride: null,
    endOverride: null,
    canceledAt: null,
    effectiveStart: start,
    effectiveEnd: end,
    joinCodeScopes: [],
    transcriptionProviderId: 'whisper',
    transcriptionStreamConfig: {},
    sessionConfigVersion: 1,
    createdAt: new Date(Date.now() - HOUR_MS).toISOString(),
    ...overrides,
  };
}

function renderPage(session: Session) {
  vi.mocked(adminApi.getSession).mockResolvedValue(session);
  return render(
    <MemoryRouter initialEntries={[`/sessions/${session.uid}`]}>
      <ToastProvider>
        <Routes>
          <Route path="/sessions/:sessionUid" element={<SessionDetailPage />} />
        </Routes>
      </ToastProvider>
    </MemoryRouter>,
  );
}

describe('SessionDetailPage cancel button gating', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('hides the Cancel button for an AUTO session', async () => {
    renderPage(makeSession({ type: 'AUTO' }));
    await screen.findByText('Test Session');
    expect(
      screen.queryByRole('button', { name: 'Cancel session' }),
    ).not.toBeInTheDocument();
  });

  it('hides the Cancel button for an ON_DEMAND session', async () => {
    renderPage(makeSession({ type: 'ON_DEMAND' }));
    await screen.findByText('Test Session');
    expect(
      screen.queryByRole('button', { name: 'Cancel session' }),
    ).not.toBeInTheDocument();
  });

  it('hides the Cancel button once the session has already started', async () => {
    renderPage(
      makeSession({
        scheduledStartTime: new Date(Date.now() - HOUR_MS).toISOString(),
      }),
    );
    await screen.findByText('Test Session');
    expect(
      screen.queryByRole('button', { name: 'Cancel session' }),
    ).not.toBeInTheDocument();
  });

  it('shows the Cancel button for an eligible upcoming SCHEDULED session', async () => {
    renderPage(makeSession());
    await screen.findByText('Test Session');
    expect(
      screen.getByRole('button', { name: 'Cancel session' }),
    ).toBeInTheDocument();
  });
});

describe('SessionDetailPage cancel flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('cancels the session, shows a success toast with Undo, and reloads', async () => {
    const session = makeSession();
    vi.mocked(adminApi.cancelSession).mockResolvedValue(null);
    renderPage(session);
    await screen.findByText('Test Session');

    fireEvent.click(screen.getByRole('button', { name: 'Cancel session' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Cancel session' }),
    );

    await waitFor(() => {
      expect(adminApi.cancelSession).toHaveBeenCalledWith(session.uid);
    });
    await screen.findByText('Session canceled.');
    // The ConfirmDialog is still mid-close-transition (and its Modal marks
    // background content aria-hidden) right after this resolves; wait for it
    // to fully unmount before querying by role.
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument();
    // load() re-fetches after a successful cancel
    await waitFor(() => {
      expect(adminApi.getSession).toHaveBeenCalledTimes(2);
    });
  });

  it('surfaces a cancel failure via an error toast', async () => {
    const session = makeSession();
    vi.mocked(adminApi.cancelSession).mockRejectedValue(
      new ApiError(
        'SESSION_NOT_UPCOMING',
        'Only upcoming sessions can be canceled.',
        422,
      ),
    );
    renderPage(session);
    await screen.findByText('Test Session');

    fireEvent.click(screen.getByRole('button', { name: 'Cancel session' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Cancel session' }),
    );

    await screen.findByText('Only upcoming sessions can be canceled.');
  });

  it('undoing a cancellation calls uncancelSession and reloads', async () => {
    const session = makeSession();
    vi.mocked(adminApi.cancelSession).mockResolvedValue(null);
    vi.mocked(adminApi.uncancelSession).mockResolvedValue(null);
    renderPage(session);
    await screen.findByText('Test Session');

    fireEvent.click(screen.getByRole('button', { name: 'Cancel session' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Cancel session' }),
    );
    await screen.findByText('Session canceled.');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));

    await waitFor(() => {
      expect(adminApi.uncancelSession).toHaveBeenCalledWith(session.uid);
    });
    await screen.findByText('Cancellation undone.');
    await waitFor(() => {
      expect(adminApi.getSession).toHaveBeenCalledTimes(3);
    });
  });

  it('maps SLOT_NO_LONGER_AVAILABLE on undo to a friendly message', async () => {
    const session = makeSession();
    vi.mocked(adminApi.cancelSession).mockResolvedValue(null);
    vi.mocked(adminApi.uncancelSession).mockRejectedValue(
      new ApiError('SLOT_NO_LONGER_AVAILABLE', 'conflict', 409),
    );
    renderPage(session);
    await screen.findByText('Test Session');

    fireEvent.click(screen.getByRole('button', { name: 'Cancel session' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Cancel session' }),
    );
    await screen.findByText('Session canceled.');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));

    await screen.findByText(
      "Can't undo — another session now occupies this time.",
    );
  });
});
