import { useEffect, useState } from 'react';

import CircleIcon from '@mui/icons-material/Circle';
import Chip from '@mui/material/Chip';
import Tooltip from '@mui/material/Tooltip';

import type { HealthReport } from '#src/lib/admin-api';
import { adminApi } from '#src/lib/admin-api';

const POLL_MS = 30_000;

function overall(report: HealthReport | null): {
  color: 'success' | 'warning' | 'error' | 'default';
  label: string;
} {
  if (!report) return { color: 'default', label: 'Unknown' };
  const ok =
    report.bff === 'ok' &&
    report.database === 'ok' &&
    report.sessionManager === 'ok';
  if (ok) return { color: 'success', label: 'Healthy' };
  if (report.sessionManager === 'unreachable' || report.database === 'fail')
    return { color: 'error', label: 'Degraded' };
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
    ? `BFF: ${report.bff} · DB: ${report.database} · Session Manager: ${report.sessionManager} (${String(report.sessionManagerLatencyMs)}ms)`
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
