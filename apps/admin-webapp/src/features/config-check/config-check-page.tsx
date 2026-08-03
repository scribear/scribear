import { useEffect } from 'react';

import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ErrorIcon from '@mui/icons-material/Error';
import InfoIcon from '@mui/icons-material/Info';
import RefreshIcon from '@mui/icons-material/Refresh';
import WarningIcon from '@mui/icons-material/Warning';
import Alert from '@mui/material/Alert';
import AlertTitle from '@mui/material/AlertTitle';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Divider from '@mui/material/Divider';
import Link from '@mui/material/Link';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';

import { TimezoneNote } from '#src/components/timezone-note';
import type {
  CheckSeverity,
  ConfigCheckReport,
  ConfigFinding,
} from '#src/lib/admin-api';
import { adminApi } from '#src/lib/admin-api';
import { useToast } from '#src/lib/toast-context';
import { useAsyncData } from '#src/lib/use-async-data';

import { DeploymentVersionsTable } from './deployment-versions-table';

/**
 * Severity presentation, most severe first. The order of this array is the
 * order of the page.
 */
const SEVERITY_META: {
  severity: Exclude<CheckSeverity, 'ok'>;
  label: string;
  color: 'error' | 'warning' | 'info';
  icon: React.ReactNode;
  /** Why a reader should care about this band, not what the band is called. */
  blurb: string;
}[] = [
  {
    severity: 'critical',
    label: 'Critical',
    color: 'error',
    icon: <ErrorIcon fontSize="small" />,
    blurb: 'Insecure or broken as configured. Fix before serving real users.',
  },
  {
    severity: 'warning',
    label: 'Warning',
    color: 'warning',
    icon: <WarningIcon fontSize="small" />,
    blurb: 'Works, but below the standard you want in front of real users.',
  },
  {
    severity: 'advisory',
    label: 'Advisory',
    color: 'info',
    icon: <InfoIcon fontSize="small" />,
    blurb: 'A deliberate choice worth knowing about. Not a defect.',
  },
];

const ENVIRONMENT_COLOR: Record<
  ConfigCheckReport['environment'],
  'default' | 'info' | 'error'
> = {
  development: 'default',
  staging: 'info',
  production: 'error',
};

/**
 * One finding.
 *
 * When the production severity differs from the local one, both are shown. That
 * pairing is the point of the page: it is what turns "this is fine here" into
 * "…and here is what it becomes when you promote it", without the reader having
 * to hold the rule in their head or re-run anything against another
 * environment.
 */
const FindingCard = ({
  finding,
  environment,
}: {
  finding: ConfigFinding;
  environment: ConfigCheckReport['environment'];
}) => {
  const meta = SEVERITY_META.find((m) => m.severity === finding.severity);
  const escalatesInProduction =
    environment !== 'production' &&
    finding.productionSeverity !== finding.severity;

  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Stack
        direction="row"
        spacing={1}
        sx={{
          alignItems: 'flex-start',
          mb: 0.5,
        }}
      >
        <Box sx={{ color: `${meta?.color ?? 'info'}.main`, mt: '2px' }}>
          {meta?.icon}
        </Box>
        {/* `component="h2"`: MUI maps the `subtitle1` variant to an `<h6>`,
            which under this page's `h1` skips four levels. The severity
            groups above are `Divider`/`Chip` decoration rather than
            headings, so each finding is the first subsection level under the
            page title - and heading navigation is how a screen-reader user
            walks the findings list. */}
        <Typography
          variant="subtitle1"
          component="h2"
          sx={{ flexGrow: 1, fontWeight: 600 }}
        >
          {finding.title}
        </Typography>
        {escalatesInProduction && (
          <Tooltip
            title={`Judged as "${finding.severity}" for a ${environment} deployment. In production the same setting is "${finding.productionSeverity}".`}
          >
            <Chip
              size="small"
              color={
                finding.productionSeverity === 'critical' ? 'error' : 'warning'
              }
              variant="outlined"
              label={`${finding.productionSeverity} in production`}
            />
          </Tooltip>
        )}
        <Chip size="small" variant="outlined" label={finding.category} />
      </Stack>
      <Typography
        variant="body2"
        sx={{
          color: 'text.secondary',
          ml: 4,
        }}
      >
        {finding.detail}
      </Typography>
      {finding.remediation !== undefined && (
        <Typography variant="body2" sx={{ ml: 4, mt: 1 }}>
          <Box component="span" sx={{ fontWeight: 600 }}>
            Fix:{' '}
          </Box>
          {finding.remediation}
        </Typography>
      )}
      {finding.docUrl !== undefined && (
        <Typography variant="body2" sx={{ ml: 4, mt: 0.5 }}>
          <Link href={finding.docUrl} target="_blank" rel="noopener noreferrer">
            Deployment guide for this step ↗
          </Link>
        </Typography>
      )}
    </Paper>
  );
};

/**
 * Configuration posture of this deployment.
 *
 * Deliberately on demand rather than polled: unlike the health rollup in the
 * top bar, nothing here changes between restarts, so a poll would spend
 * requests to redraw an identical page.
 */
export const ConfigCheckPage = () => {
  const { showApiError } = useToast();
  const {
    data: report,
    loading,
    error,
    reload,
  } = useAsyncData(() => adminApi.configCheck(), []);

  // A second request rather than a field on the report above. The two answer
  // different questions — how this deployment is configured, and which build
  // each container is running — and each has its own fan-out of upstream
  // probes, so folding them together would make the slower one gate the other.
  const {
    data: versions,
    loading: versionsLoading,
    error: versionsError,
    reload: reloadVersions,
  } = useAsyncData(() => adminApi.deploymentVersions(), []);

  // A failed run is surfaced as a toast; `report` keeps its last value (or null).
  useEffect(() => {
    if (error !== null) {
      showApiError(error, 'Failed to run the config check.');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps, @eslint-react/exhaustive-deps
  }, [error]);

  useEffect(() => {
    if (versionsError !== null) {
      showApiError(versionsError, 'Failed to read the container versions.');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps, @eslint-react/exhaustive-deps
  }, [versionsError]);

  const reloadAll = () => {
    reload();
    reloadVersions();
  };

  if (loading && report === null) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', p: 4 }}>
        <CircularProgress />
      </Box>
    );
  }

  if (report === null) {
    return (
      <Alert severity="error">
        The config check could not be run. Try again, or check the admin-server
        logs.
      </Alert>
    );
  }

  const problems = report.findings.filter((f) => f.severity !== 'ok');
  const criticalCount = report.summary.critical;

  return (
    <Box>
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 2,
          mb: 1,
          flexWrap: 'wrap',
        }}
      >
        <Typography variant="h5" component="h1" sx={{ flexGrow: 1 }}>
          Deployment Check
        </Typography>
        <Chip
          label={report.environment}
          color={ENVIRONMENT_COLOR[report.environment]}
          size="small"
        />
        <Button
          startIcon={<RefreshIcon />}
          onClick={reloadAll}
          disabled={loading || versionsLoading}
          size="small"
        >
          Re-run
        </Button>
      </Box>
      <TimezoneNote />
      <Typography
        variant="body2"
        sx={{
          color: 'text.secondary',
          mb: 2,
        }}
      >
        Every severity below is judged against a{' '}
        <strong>{report.environment}</strong> deployment.{' '}
        {report.environmentSource === 'inferred'
          ? 'DEPLOYMENT_ENV is not set, so this was inferred — set it in deployment/.env to judge against a different standard.'
          : 'Set by DEPLOYMENT_ENV in deployment/.env.'}{' '}
        Checked {new Date(report.checkedAt).toLocaleString()}. Per-container
        build versions are in <strong>Deployed versions</strong>, below.
      </Typography>
      {/* The promotion question, answered before the reader has to ask it. A
          staging deployment can be entirely green here and still be unfit for
          production, and that gap is invisible without this banner. */}
      {report.environment !== 'production' &&
        report.blockingForProduction > 0 && (
          <Alert severity="warning" sx={{ mb: 2 }}>
            <AlertTitle>
              {report.blockingForProduction} setting
              {report.blockingForProduction === 1 ? '' : 's'} would be critical
              in production
            </AlertTitle>
            Fine for {report.environment}, but this deployment is not ready to
            be promoted as configured. The affected items are tagged below.
          </Alert>
        )}
      {problems.length === 0 ? (
        <Alert severity="success" icon={<CheckCircleIcon />}>
          <AlertTitle>Nothing to report</AlertTitle>
          Every check passed for a {report.environment} deployment.
        </Alert>
      ) : (
        <>
          {criticalCount > 0 && (
            <Alert severity="error" sx={{ mb: 2 }}>
              <AlertTitle>
                {criticalCount} critical issue
                {criticalCount === 1 ? '' : 's'} in this {report.environment}{' '}
                deployment
              </AlertTitle>
              These are insecure or broken as configured, not stylistic.
            </Alert>
          )}

          <Stack spacing={3}>
            {SEVERITY_META.map((meta) => {
              const group = problems.filter(
                (f) => f.severity === meta.severity,
              );
              if (group.length === 0) return null;
              return (
                <Box key={meta.severity}>
                  <Divider textAlign="left" sx={{ mb: 1.5 }}>
                    <Chip
                      icon={meta.icon as React.ReactElement}
                      label={`${meta.label} (${String(group.length)})`}
                      color={meta.color}
                      size="small"
                    />
                  </Divider>
                  <Typography
                    variant="caption"
                    sx={{
                      color: 'text.secondary',
                      display: 'block',
                      mb: 1,
                    }}
                  >
                    {meta.blurb}
                  </Typography>
                  <Stack spacing={1.5}>
                    {group.map((f) => (
                      <FindingCard
                        key={f.id}
                        finding={f}
                        environment={report.environment}
                      />
                    ))}
                  </Stack>
                </Box>
              );
            })}
          </Stack>
        </>
      )}
      {/* Below the findings, not above them: this is reference data, and
          floating a green "every container is on one commit" banner over three
          critical misconfigurations would bury the thing that needs acting on.
          The intro paragraph points here so a reader knows it exists. */}
      <Divider sx={{ mt: 4, mb: 2 }} />
      {/* `component="h2"` for the same reason as the finding titles: the
          `h6` variant would skip four levels under the page `h1`, and this
          is a peer section of the findings list, not a sub-part of one. */}
      <Typography variant="h6" component="h2" sx={{ mb: 0.5 }}>
        Deployed versions
      </Typography>
      <Typography
        variant="body2"
        sx={{
          color: 'text.secondary',
          mb: 2,
        }}
      >
        What each container was built from. Every service knows its own build
        and none knows anyone else&apos;s, so an upgrade that pulled some images
        and not others is invisible everywhere except here — a stale container
        stays green in the health rollup.
      </Typography>
      <DeploymentVersionsTable report={versions} loading={versionsLoading} />
      <Typography
        variant="caption"
        sx={{
          color: 'text.secondary',
          display: 'block',
          mt: 3,
        }}
      >
        This page reports admin-server&apos;s own configuration directly, and
        infers the rest from what it can observe — no service discloses another
        service&apos;s environment. Secret values are never shown, only whether
        each is set and how long it is.
      </Typography>
    </Box>
  );
};
