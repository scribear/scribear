import { useEffect } from 'react';

import AddIcon from '@mui/icons-material/Add';
import DevicesIcon from '@mui/icons-material/Devices';
import MeetingRoomIcon from '@mui/icons-material/MeetingRoom';
import TabletIcon from '@mui/icons-material/Tablet';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Grid from '@mui/material/Grid';
import Typography from '@mui/material/Typography';

import { useNavigate } from 'react-router-dom';

import type { HealthReport } from '#src/lib/admin-api';
import { adminApi } from '#src/lib/admin-api';
import { ApiError, isApiErrorCode } from '#src/lib/api-error';
import { useToast } from '#src/lib/toast-context';
import { useAsyncData } from '#src/lib/use-async-data';

import { DemoRoomCard } from './demo-room-card';
import { FleetPanel } from './fleet-panel';

type HealthColor = 'success' | 'warning' | 'error' | 'default';

function statusColor(status: string): HealthColor {
  if (status === 'ok') return 'success';
  if (status === 'degraded') return 'warning';
  if (status === 'unreachable' || status === 'fail') return 'error';
  return 'default';
}

/** Compose service names are kebab-case; the dashboard shows title case. */
function componentLabel(name: string): string {
  return name
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

interface HealthTileProps {
  label: string;
  status: string;
  detail?: string;
}

/**
 * Four-up on wide screens, two-up on tablets. The rollup grew from three
 * components to four in B1.5 and will grow again with per-provider health, so
 * the tiles are rendered from the list rather than hardcoded.
 */
const HealthTile = ({ label, status, detail }: HealthTileProps) => (
  <Grid size={{ xs: 12, sm: 6, md: 3 }}>
    <Card>
      <CardContent>
        <Typography
          variant="body2"
          gutterBottom
          sx={{
            color: 'text.secondary',
          }}
        >
          {label}
        </Typography>
        <Chip size="small" label={status} color={statusColor(status)} />
        {detail !== undefined && (
          <Typography
            variant="caption"
            sx={{
              color: 'text.secondary',
              display: 'block',
              mt: 1,
            }}
          >
            {detail}
          </Typography>
        )}
      </CardContent>
    </Card>
  </Grid>
);

export const DashboardPage = () => {
  const navigate = useNavigate();
  const { showError } = useToast();
  const {
    data: health,
    loading: healthLoading,
    error: healthError,
  } = useAsyncData<HealthReport>(() => adminApi.health(), []);
  const {
    data: pendingDevices,
    loading: pendingLoading,
    error: pendingError,
  } = useAsyncData(
    () => adminApi.listDevices({ active: false, limit: 200 }),
    [],
  );

  const pendingCount = pendingDevices?.items.length ?? null;
  // A misconfiguration on either read raises the same banner; derived here
  // rather than stored so both fetches feed it without shared effect state.
  const misconfigured =
    isApiErrorCode(healthError, 'BACKEND_MISCONFIGURATION') ||
    isApiErrorCode(pendingError, 'BACKEND_MISCONFIGURATION');

  // Any other load failure is surfaced as a toast, once per error.
  useEffect(() => {
    if (
      healthError !== null &&
      !isApiErrorCode(healthError, 'BACKEND_MISCONFIGURATION')
    ) {
      showError(
        healthError instanceof ApiError
          ? healthError.message
          : 'Failed to load health.',
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps, @eslint-react/exhaustive-deps
  }, [healthError]);
  useEffect(() => {
    if (
      pendingError !== null &&
      !isApiErrorCode(pendingError, 'BACKEND_MISCONFIGURATION')
    ) {
      showError(
        pendingError instanceof ApiError
          ? pendingError.message
          : 'Failed to load devices.',
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps, @eslint-react/exhaustive-deps
  }, [pendingError]);

  return (
    <Box>
      <Typography variant="h5" component="h1" sx={{ mb: 2 }}>
        Dashboard
      </Typography>
      {misconfigured && (
        <Alert severity="error" sx={{ mb: 2 }}>
          Admin backend misconfiguration — an operator must check the
          server&apos;s ADMIN_API_KEY.
        </Alert>
      )}
      <Typography variant="h6" component="h2" sx={{ mb: 1 }}>
        System health
      </Typography>
      {healthLoading ? (
        <Box sx={{ display: 'flex', py: 2 }}>
          <CircularProgress size={24} />
        </Box>
      ) : health ? (
        <Grid container spacing={2} sx={{ mb: 3 }}>
          <HealthTile
            label="BFF (Admin Server)"
            status={health.bff}
            detail={`checked ${new Date(health.checkedAt).toLocaleTimeString()}`}
          />
          {health.components.map((component) => (
            <HealthTile
              key={component.name}
              label={componentLabel(component.name)}
              status={component.status}
              // The cause, when there is one, beats the latency: a red tile
              // that only says "312ms" tells an operator nothing actionable.
              detail={component.detail ?? `${String(component.latencyMs)}ms`}
            />
          ))}
        </Grid>
      ) : (
        <Typography
          sx={{
            color: 'text.secondary',
            mb: 3,
          }}
        >
          Health status unavailable.
        </Typography>
      )}
      <DemoRoomCard />
      <FleetPanel />
      <Typography variant="h6" component="h2" sx={{ mb: 1 }}>
        Pending activations
      </Typography>
      <Card sx={{ mb: 3, maxWidth: 320 }}>
        <CardContent>
          {pendingLoading ? (
            <CircularProgress size={24} />
          ) : (
            <Typography variant="h3" component="div">
              {pendingCount ?? '—'}
            </Typography>
          )}
          <Typography
            variant="body2"
            sx={{
              color: 'text.secondary',
            }}
          >
            devices awaiting activation
          </Typography>
        </CardContent>
      </Card>
      <Typography variant="h6" component="h2" sx={{ mb: 1 }}>
        Quick actions
      </Typography>
      <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
        <Button
          variant="contained"
          startIcon={<MeetingRoomIcon />}
          endIcon={<AddIcon />}
          onClick={() => {
            void navigate('/rooms');
          }}
        >
          New room
        </Button>
        <Button
          variant="contained"
          startIcon={<DevicesIcon />}
          endIcon={<AddIcon />}
          onClick={() => {
            void navigate('/devices');
          }}
        >
          New device
        </Button>
        <Button
          variant="outlined"
          startIcon={<TabletIcon />}
          onClick={() => {
            void navigate('/kiosk-setup');
          }}
        >
          Set up a kiosk
        </Button>
      </Box>
    </Box>
  );
};
