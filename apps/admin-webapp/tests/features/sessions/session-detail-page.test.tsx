import type { ReactElement } from 'react';

import { screen, waitFor } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, vi } from 'vitest';

import { SessionDetailPage } from '#src/features/sessions/session-detail-page';
import { adminApi } from '#src/lib/admin-api';
import { ApiError } from '#src/lib/api-error';

import { renderWithProviders } from '../../utils/render-with-providers';
import { buildSession } from './fixtures';

vi.mock('#src/lib/admin-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#src/lib/admin-api')>();
  return {
    ...actual,
    adminApi: {
      getSession: vi.fn(),
      getSessionJoinCode: vi.fn(),
    },
  };
});

vi.mock('#src/features/dashboard/use-fleet', () => ({
  useFleet: vi.fn(() => ({
    snapshot: null,
    sessionEvents: new Map(),
    connected: false,
    available: false,
    refresh: vi.fn(),
  })),
}));

const SESSION_UID = 'session-1';

function renderPage(ui: ReactElement = <SessionDetailPage />) {
  return renderWithProviders(
    <Routes>
      <Route path="/sessions/:sessionUid" element={ui} />
    </Routes>,
    { route: `/sessions/${SESSION_UID}` },
  );
}

async function waitForLoad() {
  await waitFor(() => {
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });
}

describe('SessionDetailPage', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Neutral default so tests unrelated to the join-code section don't have
    // to stub it individually; overridden per-case below.
    vi.mocked(adminApi.getSessionJoinCode).mockResolvedValue({
      status: 'not-active',
      joinCode: null,
      validEnd: null,
    });
  });

  describe('loading', (it) => {
    it('shows a spinner while the initial load is in flight', () => {
      // Arrange
      vi.mocked(adminApi.getSession).mockReturnValue(
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

  describe('not-found state', (it) => {
    it('shows "Session not found." on a 404 ApiError', async () => {
      // Arrange
      vi.mocked(adminApi.getSession).mockRejectedValue(
        new ApiError('NOT_FOUND', 'no such session', 404),
      );

      // Act
      renderPage();
      await waitForLoad();

      // Assert
      expect(await screen.findByText('Session not found.')).toBeInTheDocument();
    });
  });

  describe('error state', (it) => {
    it('shows a toast and the not-found fallback on a non-404, non-ApiError rejection', async () => {
      // Arrange
      vi.mocked(adminApi.getSession).mockRejectedValue(
        new Error('network down'),
      );

      // Act
      renderPage();
      await waitForLoad();

      // Assert
      expect(
        await screen.findByText('Failed to load session.'),
      ).toBeInTheDocument();
      expect(screen.getByText('Session not found.')).toBeInTheDocument();
    });
  });

  describe('BACKEND_MISCONFIGURATION', (it) => {
    it('shows the ADMIN_API_KEY alert as the entire page body', async () => {
      // Arrange
      vi.mocked(adminApi.getSession).mockRejectedValue(
        new ApiError('BACKEND_MISCONFIGURATION', 'nope', 502),
      );

      // Act
      renderPage();
      await waitForLoad();

      // Assert
      expect(
        await screen.findByText(/admin backend misconfiguration/i),
      ).toBeInTheDocument();
      expect(screen.queryByText('Session not found.')).not.toBeInTheDocument();
    });
  });

  describe('loaded state', (it) => {
    it('renders the session fields once loaded', async () => {
      // Arrange
      vi.mocked(adminApi.getSession).mockResolvedValue(
        buildSession({ name: 'CS 225 Lecture', roomUid: 'room-1' }),
      );

      // Act
      renderPage();
      await waitForLoad();

      // Assert
      expect(screen.getByText('CS 225 Lecture')).toBeInTheDocument();
      expect(screen.getByText('room-1')).toBeInTheDocument();
    });
  });

  describe('join session', (it) => {
    beforeEach(() => {
      vi.mocked(adminApi.getSession).mockResolvedValue(
        buildSession({ name: 'CS 225 Lecture', roomUid: 'room-1' }),
      );
    });

    it('shows a muted message when the session has no join code scopes', async () => {
      // Arrange
      vi.mocked(adminApi.getSessionJoinCode).mockResolvedValue({
        status: 'no-join-scopes',
        joinCode: null,
        validEnd: null,
      });

      // Act
      renderPage();
      await waitForLoad();

      // Assert
      expect(
        await screen.findByText(
          'No join code scopes configured for this session.',
        ),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole('link', { name: /open live captions/i }),
      ).not.toBeInTheDocument();
    });

    it('shows a muted message when the session is not currently active', async () => {
      // Arrange
      vi.mocked(adminApi.getSessionJoinCode).mockResolvedValue({
        status: 'not-active',
        joinCode: null,
        validEnd: null,
      });

      // Act
      renderPage();
      await waitForLoad();

      // Assert
      expect(
        await screen.findByText(
          'Session is not currently active — no join code available.',
        ),
      ).toBeInTheDocument();
    });

    it('shows the join code, copy buttons, and an open-live-captions link when active', async () => {
      // Arrange
      vi.mocked(adminApi.getSessionJoinCode).mockResolvedValue({
        status: 'ok',
        joinCode: 'ABC12345',
        validEnd: '2026-08-01T00:05:00.000Z',
      });

      // Act
      renderPage();
      await waitForLoad();

      // Assert
      expect(await screen.findByText('ABC12345')).toBeInTheDocument();
      const link = screen.getByRole('link', {
        name: /open live captions/i,
      });
      expect(link).toHaveAttribute(
        'href',
        expect.stringContaining('/client/#config='),
      );
      expect(
        screen.getAllByRole('button', { name: /copy join/i }),
      ).toHaveLength(2);
    });
  });
});
