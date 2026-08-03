import { act } from 'react';

import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, vi } from 'vitest';

import {
  ALERTS_POLL_INTERVAL_MS,
  useAlerts,
} from '#src/features/dashboard/use-alerts';
import type { AlertsReport, MonitoringAlert } from '#src/lib/admin-api';
import { adminApi } from '#src/lib/admin-api';
import { ApiError } from '#src/lib/api-error';

vi.mock('#src/lib/admin-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#src/lib/admin-api')>();
  return {
    ...actual,
    adminApi: { alerts: vi.fn() },
  };
});

function fakeAlert(overrides: Partial<MonitoringAlert> = {}): MonitoringAlert {
  return {
    id: 'asr-worker-dead',
    failureModes: ['T9'],
    severity: 'critical',
    summary: '1 transcription worker process(es) have exited (worker 0).',
    likelyCause: 'A worker died after startup.',
    stage: 'transcription',
    value: 1,
    threshold: 0,
    ...overrides,
  };
}

const emptyReport: AlertsReport = {
  alerts: [],
  generatedAt: '2026-08-02T00:00:00.000Z',
};

describe('useAlerts', (it) => {
  beforeEach(() => {
    vi.mocked(adminApi.alerts).mockReset();
  });

  it('starts in the loading state, not a premature "ok" or "unavailable"', () => {
    vi.mocked(adminApi.alerts).mockReturnValue(new Promise(() => undefined));

    const { result } = renderHook(() => useAlerts());

    expect(result.current.state).toEqual({ status: 'loading' });
  });

  it('moves to "ok" with the report on a successful read, including an empty list', async () => {
    vi.mocked(adminApi.alerts).mockResolvedValue(emptyReport);

    const { result } = renderHook(() => useAlerts());

    await waitFor(() => {
      expect(result.current.state.status).toBe('ok');
    });
    expect(result.current.state).toEqual({ status: 'ok', ...emptyReport });
  });

  it('carries firing alerts through unchanged', async () => {
    const report: AlertsReport = { alerts: [fakeAlert()], generatedAt: 'now' };
    vi.mocked(adminApi.alerts).mockResolvedValue(report);

    const { result } = renderHook(() => useAlerts());

    await waitFor(() => {
      expect(result.current.state.status).toBe('ok');
    });
    expect(result.current.state).toEqual({ status: 'ok', ...report });
  });

  it('moves to "unavailable" on a rejected read, never falling back to an empty "ok"', async () => {
    // The trap this pins: a naive catch that swallows the error and leaves
    // `alerts: []` in place would be indistinguishable from a healthy,
    // nothing-firing deployment — exactly the bug PLAN-VisibleErrors §4.3
    // exists to prevent.
    vi.mocked(adminApi.alerts).mockRejectedValue(
      new ApiError('ALERTS_UNAVAILABLE', 'sidecar did not answer', 503),
    );

    const { result } = renderHook(() => useAlerts());

    await waitFor(() => {
      expect(result.current.state.status).toBe('unavailable');
    });
    expect(result.current.state).toEqual({
      status: 'unavailable',
      message: 'sidecar did not answer',
      severity: 'error',
    });
  });

  it('classifies a 429 as a warning with retry copy, not as an unavailable pipeline', async () => {
    // admin-server's limiter is `global: true` and this hook polls every 15 s,
    // so a 429 is a reachable state here. It means "ask again shortly" — the
    // sidecar was never asked, and nothing about the pipeline is known to be
    // wrong.
    vi.mocked(adminApi.alerts).mockRejectedValue(
      new ApiError(
        'RATE_LIMITED',
        'Too many requests. Please retry after 1 minute.',
        429,
        'req-1',
        { retryAfter: '1 minute' },
      ),
    );

    const { result } = renderHook(() => useAlerts());

    await waitFor(() => {
      expect(result.current.state.status).toBe('unavailable');
    });
    expect(result.current.state).toEqual({
      status: 'unavailable',
      message:
        'Too many requests — the admin server is rate limiting this browser. Nothing was changed; wait 1 minute, then try again.',
      severity: 'warning',
    });
  });

  it('falls back to a generic message for a non-ApiError rejection', async () => {
    vi.mocked(adminApi.alerts).mockRejectedValue(new Error('boom'));

    const { result } = renderHook(() => useAlerts());

    await waitFor(() => {
      expect(result.current.state.status).toBe('unavailable');
    });
    expect(result.current.state).toEqual({
      status: 'unavailable',
      message: 'Could not reach the admin server.',
      severity: 'error',
    });
  });

  it('refresh() re-fetches on demand', async () => {
    vi.mocked(adminApi.alerts).mockResolvedValue(emptyReport);
    const { result } = renderHook(() => useAlerts());
    await waitFor(() => {
      expect(result.current.state.status).toBe('ok');
    });
    const callsBefore = vi.mocked(adminApi.alerts).mock.calls.length;

    act(() => {
      result.current.refresh();
    });

    await waitFor(() => {
      expect(vi.mocked(adminApi.alerts).mock.calls.length).toBeGreaterThan(
        callsBefore,
      );
    });
  });
});

describe('useAlerts poll timer', (it) => {
  let originalHidden: boolean;

  beforeEach(() => {
    vi.mocked(adminApi.alerts).mockReset();
    vi.mocked(adminApi.alerts).mockResolvedValue(emptyReport);
    vi.useFakeTimers();
    originalHidden = document.hidden;
    Object.defineProperty(document, 'hidden', {
      value: false,
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(document, 'hidden', {
      value: originalHidden,
      writable: true,
      configurable: true,
    });
  });

  it('re-fetches on the poll interval', () => {
    renderHook(() => useAlerts());
    const fetchesAfterMount = vi.mocked(adminApi.alerts).mock.calls.length;

    act(() => {
      vi.advanceTimersByTime(ALERTS_POLL_INTERVAL_MS);
    });

    expect(vi.mocked(adminApi.alerts).mock.calls.length).toBeGreaterThan(
      fetchesAfterMount,
    );
  });

  it('does not re-fetch while the document is hidden', () => {
    renderHook(() => useAlerts());
    const fetchesAfterMount = vi.mocked(adminApi.alerts).mock.calls.length;

    Object.defineProperty(document, 'hidden', {
      value: true,
      writable: true,
      configurable: true,
    });
    act(() => {
      vi.advanceTimersByTime(ALERTS_POLL_INTERVAL_MS * 3);
    });

    expect(vi.mocked(adminApi.alerts).mock.calls.length).toBe(
      fetchesAfterMount,
    );
  });

  it('clears the timer on unmount', () => {
    const { unmount } = renderHook(() => useAlerts());
    const fetchesAfterMount = vi.mocked(adminApi.alerts).mock.calls.length;

    unmount();
    act(() => {
      vi.advanceTimersByTime(ALERTS_POLL_INTERVAL_MS * 5);
    });

    expect(vi.mocked(adminApi.alerts).mock.calls.length).toBe(
      fetchesAfterMount,
    );
  });
});
