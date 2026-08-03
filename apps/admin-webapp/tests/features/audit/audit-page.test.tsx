import { screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, vi } from 'vitest';

import { AuditPage } from '#src/features/audit/audit-page';
import type { AuditRow } from '#src/lib/admin-api';
import { adminApi } from '#src/lib/admin-api';
import { ApiError } from '#src/lib/api-error';

import { renderWithProviders } from '../../utils/render-with-providers';

vi.mock('#src/lib/admin-api', () => ({
  adminApi: { listAudit: vi.fn() },
}));

function buildRow(overrides: Partial<AuditRow> = {}): AuditRow {
  return {
    id: 'audit-1',
    actorSubject: 'admin',
    actorProvider: 'local',
    action: 'create-room',
    target: 'room-1',
    paramsSummary: {},
    result: 'success',
    statusCode: 200,
    requestId: 'req-1',
    createdAt: '2026-08-02T00:00:00.000Z',
    ...overrides,
  };
}

async function waitForLoad() {
  await waitFor(() => {
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });
}

describe('AuditPage', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe('loading', (it) => {
    it('shows a spinner and neither the empty nor the failed wording', () => {
      // Arrange
      vi.mocked(adminApi.listAudit).mockReturnValue(
        new Promise(() => {
          /* never resolves */
        }),
      );

      // Act
      renderWithProviders(<AuditPage />);

      // Assert
      expect(screen.getByRole('progressbar')).toBeInTheDocument();
      expect(
        screen.queryByText('No audit entries found.'),
      ).not.toBeInTheDocument();
    });
  });

  describe('empty state', (it) => {
    it('says "No audit entries found." only when the log really is empty', async () => {
      // Arrange
      vi.mocked(adminApi.listAudit).mockResolvedValue({ items: [] });

      // Act
      renderWithProviders(<AuditPage />);
      await waitForLoad();

      // Assert
      expect(screen.getByText('No audit entries found.')).toBeInTheDocument();
    });
  });

  describe('failed state', (it) => {
    it('never says "No audit entries found." when the load failed', async () => {
      // Arrange - an unread audit log is not an empty one; on this page in
      // particular the difference is "nobody did anything" vs "we cannot say".
      vi.mocked(adminApi.listAudit).mockRejectedValue(
        new ApiError('UPSTREAM_UNREACHABLE', 'unreachable', 503, 'req-77'),
      );

      // Act
      renderWithProviders(<AuditPage />);
      await waitForLoad();

      // Assert
      expect(
        await screen.findByText('Could not load the audit log.'),
      ).toBeInTheDocument();
      expect(
        screen.queryByText('No audit entries found.'),
      ).not.toBeInTheDocument();
      expect(screen.getByText('req-77')).toBeInTheDocument();
    });
  });

  describe('rows', (it) => {
    it('renders a row from the API', async () => {
      // Arrange
      vi.mocked(adminApi.listAudit).mockResolvedValue({
        items: [buildRow({ action: 'delete-room' })],
      });

      // Act
      renderWithProviders(<AuditPage />);
      await waitForLoad();

      // Assert
      expect(screen.getByText('delete-room')).toBeInTheDocument();
    });
  });
});
