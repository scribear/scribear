import { useEffect, useState } from 'react';

import CircleIcon from '@mui/icons-material/Circle';
import Chip from '@mui/material/Chip';
import Tooltip from '@mui/material/Tooltip';

import type { HealthReport } from '#src/lib/admin-api';
import { adminApi } from '#src/lib/admin-api';

const POLL_MS = 30_000;

/**
 * Worst-of across every reported component.
 *
 * Derived from the list rather than from named fields, so a component added
 * server-side is accounted for here automatically. The previous version
 * hardcoded three names and would have reported "Healthy" while a newly-added
 * dependency was down.
 */
function overall(report: HealthReport): {
  color: 'success' | 'warning' | 'error' | 'default';
  label: string;
} {
  // 'not-configured' components (e.g. redis with REDIS_URL unset) are an
  // intentional deployment choice, not a fault — excluded here so an operator
  // who never configured an optional dependency still sees "Healthy".
  const statuses = [
    report.bff,
    ...report.components.map((c) => c.status),
  ].filter((s) => s !== 'not-configured');
  if (statuses.every((s) => s === 'ok'))
    return { color: 'success', label: 'Healthy' };
  // 'fail' and 'unreachable' are hard down; 'degraded' is working-but-impaired.
  if (statuses.some((s) => s === 'fail' || s === 'unreachable'))
    return { color: 'error', label: 'Down' };
  return { color: 'warning', label: 'Degraded' };
}

/**
 * The three things this chip can honestly say, as a discriminated state —
 * same `loading | ok | unavailable` vocabulary as `useAlerts` and
 * `useAsyncList`.
 *
 * It replaces a single `HealthReport | null`, under which a dead admin server
 * and a console that had simply not polled yet were both rendered as the same
 * grey "Unknown" chip (PLAN-VisibleErrors §5). Worse, a *successful* first
 * poll followed by failures reverted to "Unknown" — the console silently
 * downgraded from knowing to not knowing, in the one widget an operator
 * glances at to decide whether anything is wrong.
 */
type HealthState =
  | { status: 'loading' }
  | { status: 'ok'; report: HealthReport }
  | { status: 'unavailable' };

/**
 * Compact health chip that polls the BFF `/health` rollup. Hover for detail.
 */
export const HealthIndicator = () => {
  const [state, setState] = useState<HealthState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    const poll = () => {
      adminApi
        .health()
        .then((r) => {
          if (!cancelled) setState({ status: 'ok', report: r });
        })
        .catch(() => {
          // Not swallowed: `/health` is unauthenticated-adjacent and cheap, so
          // a rejection means the admin server (or the network to it) is down.
          // That is a harder fact than anything in the report, and the chip
          // says so rather than reverting to grey.
          if (!cancelled) setState({ status: 'unavailable' });
        });
    };
    poll();
    const timer = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const { color, label } =
    state.status === 'ok'
      ? overall(state.report)
      : state.status === 'loading'
        ? ({ color: 'default', label: 'Checking…' } as const)
        : ({ color: 'error', label: 'Unreachable' } as const);

  const tip =
    state.status === 'ok'
      ? [
          `BFF: ${state.report.bff}`,
          ...state.report.components.map((c) => {
            // The cause beats the latency: a red "session-manager: fail" tells an
            // operator nothing the detail ("database: fail") does not tell better.
            const suffix =
              c.detail !== undefined && c.detail !== ''
                ? ` — ${c.detail}`
                : ` (${String(c.latencyMs)}ms)`;
            return `${c.name}: ${c.status}${suffix}`;
          }),
        ].join(' · ')
      : state.status === 'loading'
        ? 'Reading the deployment health rollup…'
        : 'Could not reach the admin server, so nothing here is known to be healthy. Check that the admin-server container is running and that this browser can reach it.';

  return (
    <Tooltip title={tip}>
      <Chip
        size="small"
        color={color}
        icon={<CircleIcon sx={{ fontSize: 12 }} />}
        label={label}
        variant="outlined"
        sx={{ color: 'inherit', borderColor: 'currentColor' }}
      />
    </Tooltip>
  );
};
