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
function overall(report: HealthReport | null): {
  color: 'success' | 'warning' | 'error' | 'default';
  label: string;
} {
  if (!report) return { color: 'default', label: 'Unknown' };

  const statuses = [report.bff, ...report.components.map((c) => c.status)];
  if (statuses.every((s) => s === 'ok'))
    return { color: 'success', label: 'Healthy' };
  // 'fail' and 'unreachable' are hard down; 'degraded' is working-but-impaired.
  if (statuses.some((s) => s === 'fail' || s === 'unreachable'))
    return { color: 'error', label: 'Down' };
  return { color: 'warning', label: 'Degraded' };
}

/**
 * Compact health chip that polls the BFF `/health` rollup. Hover for detail.
 */
export const HealthIndicator = () => {
  const [report, setReport] = useState<HealthReport | null>(null);

  useEffect(() => {
    let cancelled = false;
    const poll = () => {
      adminApi
        .health()
        .then((r) => {
          if (!cancelled) setReport(r);
        })
        .catch(() => {
          if (!cancelled) setReport(null);
        });
    };
    poll();
    const timer = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const { color, label } = overall(report);
  const tip = report
    ? [
        `BFF: ${report.bff}`,
        ...report.components.map((c) => {
          // The cause beats the latency: a red "session-manager: fail" tells an
          // operator nothing the detail ("database: fail") does not tell better.
          const suffix =
            c.detail !== undefined && c.detail !== ''
              ? ` — ${c.detail}`
              : ` (${String(c.latencyMs)}ms)`;
          return `${c.name}: ${c.status}${suffix}`;
        }),
      ].join(' · ')
    : 'Health unknown';

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
