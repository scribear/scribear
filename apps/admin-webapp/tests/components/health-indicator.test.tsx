import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, vi } from 'vitest';

import { HealthIndicator } from '#src/components/health-indicator';
import type { HealthReport } from '#src/lib/admin-api';
import { adminApi } from '#src/lib/admin-api';
import { ApiError } from '#src/lib/api-error';

vi.mock('#src/lib/admin-api', () => ({
  adminApi: { health: vi.fn() },
}));

function buildReport(overrides: Partial<HealthReport> = {}): HealthReport {
  return {
    bff: 'ok',
    components: [{ name: 'session-manager', status: 'ok', latencyMs: 4 }],
    checkedAt: '2026-08-02T00:00:00.000Z',
    ...overrides,
  };
}

describe('HealthIndicator', (it) => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('says it is still checking before the first poll answers', () => {
    // Arrange
    vi.mocked(adminApi.health).mockReturnValue(
      new Promise(() => {
        /* never resolves */
      }),
    );

    // Act
    render(<HealthIndicator />);

    // Assert
    expect(screen.getByText('Checking…')).toBeInTheDocument();
  });

  it('reports the rollup once it has one', async () => {
    // Arrange
    vi.mocked(adminApi.health).mockResolvedValue(buildReport());

    // Act
    render(<HealthIndicator />);

    // Assert
    expect(await screen.findByText('Healthy')).toBeInTheDocument();
  });

  it('says "Unreachable", not "Checking…", when the admin server is down', async () => {
    // Arrange - a dead admin server and a console that has not polled yet used
    // to render the same grey "Unknown" chip (PLAN-VisibleErrors §5).
    vi.mocked(adminApi.health).mockRejectedValue(
      new ApiError('NETWORK', 'Could not reach the admin server.', 0),
    );

    // Act
    render(<HealthIndicator />);

    // Assert
    expect(await screen.findByText('Unreachable')).toBeInTheDocument();
    expect(screen.queryByText('Checking…')).not.toBeInTheDocument();
    // The word carries the state, not just the colour (WCAG SC 1.4.1).
    await waitFor(() => {
      expect(screen.queryByText('Unknown')).not.toBeInTheDocument();
    });
  });
});
