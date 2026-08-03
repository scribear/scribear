import ErrorOutlineIcon from '@mui/icons-material/ErrorOutlineOutlined';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

import type {
  MonitoringAlert,
  MonitoringAlertSeverity,
} from '#src/lib/admin-api';

import { useAlerts } from './use-alerts';

/**
 * Maps the sidecar's two severities onto the console's vocabulary
 * (PLAN-VisibleErrors §10): `critical` is terminal/action-required, so it
 * becomes `error`; `warning` is degraded/no action yet, so it stays
 * `warning`. There is no `info` mapping — the sidecar only ever reports a
 * rule that is *firing*, so nothing it sends is ever the "waiting, expected"
 * case; the healthy state is the empty list rendered below, not a severity.
 */
const SEVERITY_CHIP_COLOR: Record<
  MonitoringAlertSeverity,
  'error' | 'warning'
> = {
  critical: 'error',
  warning: 'warning',
};

const SEVERITY_LABEL: Record<MonitoringAlertSeverity, string> = {
  critical: 'error',
  warning: 'warning',
};

/**
 * One firing alert. Colour is never the only signal (SC 1.4.1): the chip
 * carries the word "error"/"warning" as well as its colour, and an icon
 * beside it — matching `session-detail-page.tsx`'s `ReportProblemIcon`
 * pattern for a flagged loss.
 *
 * No `aria-live` here: these cards re-render on every 15 s poll, and a live
 * region that re-announced the whole card list on every unchanged poll would
 * be unusable (the same reasoning `StagePipelineTable`'s doc comment gives
 * for not wrapping a frequently-polled table in one). The summary rollup
 * above carries the one polite live region for this panel, same split
 * `fleet-panel.tsx`'s audio roll-up uses.
 */
const AlertCard = ({ alert }: { alert: MonitoringAlert }) => {
  const Icon =
    alert.severity === 'critical' ? ErrorOutlineIcon : WarningAmberIcon;
  return (
    <Card variant="outlined">
      <CardContent sx={{ py: 1.5, '&:last-child': { pb: 1.5 } }}>
        <Stack
          direction="row"
          spacing={1}
          useFlexGap
          sx={{ alignItems: 'center', mb: 0.5, flexWrap: 'wrap' }}
        >
          <Chip
            size="small"
            label={SEVERITY_LABEL[alert.severity]}
            color={SEVERITY_CHIP_COLOR[alert.severity]}
            icon={<Icon aria-hidden="true" />}
          />
          <Chip size="small" variant="outlined" label={alert.stage} />
          <Typography
            variant="caption"
            sx={{
              color: 'text.secondary',
              fontFamily: 'monospace',
              wordBreak: 'break-all',
            }}
          >
            {alert.id}
          </Typography>
        </Stack>
        <Typography variant="body2">{alert.summary}</Typography>
        <Typography
          variant="caption"
          sx={{ color: 'text.secondary', display: 'block', mt: 0.5 }}
        >
          {alert.likelyCause}
        </Typography>
      </CardContent>
    </Card>
  );
};

/**
 * "Are captions working right now" (PLAN-VisibleErrors §4.3): the monitoring
 * sidecar already evaluates the failure catalog's rules — including the
 * synthetic canary — every time `/alerts` is read, and until this panel
 * existed the admin console never asked. Placed at the top of the dashboard,
 * above `FleetPanel`, because a firing `error` alert here is a more direct
 * answer than any per-session status the fleet grid below can show.
 *
 * The `unavailable` branch is not cosmetic: rendering the empty-list "green"
 * state for a fetch failure is exactly the bug this panel exists to fix (§4.4
 * catalogs the sibling mistake on the fleet poll), so a failed read gets its
 * own assertive `Alert` rather than silently falling back to "no alerts".
 */
export const AlertsPanel = () => {
  const { state } = useAlerts();

  if (state.status === 'loading') {
    // Nothing yet rather than a placeholder "No alerts" that would flash
    // green before the first read completes.
    return null;
  }

  if (state.status === 'unavailable') {
    return (
      <Alert severity={state.severity} sx={{ mb: 3 }}>
        Could not read monitoring-sidecar alerts — this is not the same as "no
        alerts firing"; the pipeline&apos;s health is currently unknown.{' '}
        {state.message}
      </Alert>
    );
  }

  const { alerts } = state;
  const criticalCount = alerts.filter((a) => a.severity === 'critical').length;
  const warningCount = alerts.length - criticalCount;

  return (
    <Box sx={{ mb: 3 }}>
      <Typography variant="h6" component="h2" sx={{ mb: 1 }}>
        Pipeline alerts
      </Typography>
      <Stack
        direction="row"
        spacing={1}
        useFlexGap
        sx={{ flexWrap: 'wrap', mb: 1.5 }}
        aria-live="polite"
        aria-label="Pipeline alert summary"
      >
        <Chip
          size="small"
          label={`error: ${String(criticalCount)}`}
          color={criticalCount > 0 ? 'error' : 'default'}
          variant={criticalCount > 0 ? 'filled' : 'outlined'}
        />
        <Chip
          size="small"
          label={`warning: ${String(warningCount)}`}
          color={warningCount > 0 ? 'warning' : 'default'}
          variant={warningCount > 0 ? 'filled' : 'outlined'}
        />
      </Stack>
      {alerts.length === 0 ? (
        <Typography sx={{ color: 'text.secondary' }}>
          No alerts firing — every monitored rule (transcription health,
          authentication, service probes, the synthetic canary) is currently
          green.
        </Typography>
      ) : (
        <Stack spacing={1}>
          {alerts.map((alert) => (
            <AlertCard key={alert.id} alert={alert} />
          ))}
        </Stack>
      )}
    </Box>
  );
};
