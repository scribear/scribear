import type { ReactElement } from 'react';

import { beforeEach, describe, expect, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';

import { Route, Routes } from 'react-router-dom';

import { SessionDetailPage } from '#src/features/sessions/session-detail-page';
import { adminApi } from '#src/lib/admin-api';
import { ApiError } from '#src/lib/api-error';

import { renderWithProviders } from '../../utils/render-with-providers';
import { buildSession } from './fixtures';

vi.mock('#src/lib/admin-api', () => ({
  adminApi: {
    getSession: vi.fn(),
  },
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
      expect(
        await screen.findByText('Session not found.'),
      ).toBeInTheDocument();
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
      expect(
        screen.queryByText('Session not found.'),
      ).not.toBeInTheDocument();
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
});
