import { useEffect, useState } from 'react';

import type { MonitoringAlert } from '#src/lib/admin-api';
import { adminApi } from '#src/lib/admin-api';
import {
  type ErrorSeverity,
  errorMessage,
  errorSeverity,
} from '#src/lib/api-error';

/**
 * How often the dashboard re-reads `/alerts`. Independent of
 * `FLEET_POLL_INTERVAL_MS`: these rules evaluate 120 s rate windows and a
 * synthetic canary that runs far less often than audio levels move, so a
 * tighter poll would buy nothing but load.
 */
export const ALERTS_POLL_INTERVAL_MS = 15_000;

/**
 * A discriminated state rather than `{ alerts: [], error }` — the same
 * `useAsyncList`-shaped discipline PLAN-VisibleErrors §10.2 calls for,
 * because the entire point of this feature is that "no alerts firing" and
 * "could not ask" must be unrepresentable as the same state.
 */
export type AlertsState =
  | { status: 'loading' }
  | { status: 'ok'; alerts: MonitoringAlert[]; generatedAt: string }
  /** `severity` travels with the message because admin-server rate limits
   *  every route: a 429 here means "ask again shortly", not "the pipeline is
   *  broken", and must not be painted the same red. */
  | { status: 'unavailable'; message: string; severity: ErrorSeverity };

export interface UseAlertsResult {
  state: AlertsState;
  /** Re-fetch on demand, e.g. a manual "retry" affordance. */
  refresh: () => void;
}

/**
 * Polls admin-server's `/alerts` (a thin proxy over the monitoring sidecar's
 * `GET /api/monitoring/v1/alerts`), pausing while the tab is hidden and
 * catching up immediately on return — same visibility discipline
 * `useFleet`'s poll uses, for the same reason: a hidden tab must not present
 * a stale read as current once it is looked at again.
 */
export function useAlerts(): UseAlertsResult {
  const [state, setState] = useState<AlertsState>({ status: 'loading' });
  const [refreshNonce, setRefreshNonce] = useState(0);

  useEffect(() => {
    const alive = { current: true };

    adminApi
      .alerts()
      .then((report) => {
        if (!alive.current) return;
        setState({
          status: 'ok',
          alerts: report.alerts,
          generatedAt: report.generatedAt,
        });
      })
      .catch((err: unknown) => {
        if (!alive.current) return;
        setState({
          status: 'unavailable',
          message: errorMessage(err, 'Could not reach the admin server.'),
          severity: errorSeverity(err),
        });
      });

    return () => {
      alive.current = false;
    };
  }, [refreshNonce]);

  useEffect(() => {
    const poll = () => {
      setRefreshNonce((n) => n + 1);
    };

    const id = window.setInterval(() => {
      if (!document.hidden) poll();
    }, ALERTS_POLL_INTERVAL_MS);

    const onVisibilityChange = () => {
      if (!document.hidden) poll();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, []);

  return {
    state,
    refresh: () => {
      setRefreshNonce((n) => n + 1);
    },
  };
}
