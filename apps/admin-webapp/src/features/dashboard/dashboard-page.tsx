import { useEffect, useState } from 'react';

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
import { ApiError } from '#src/lib/api-error';
import { useToast } from '#src/lib/toast-context';

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
        <Typography variant="body2" color="text.secondary" gutterBottom>
          {label}
        </Typography>
        <Chip size="small" label={status} color={statusColor(status)} />
        {detail !== undefined && (
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ display: 'block', mt: 1 }}
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
  const [health, setHealth] = useState<HealthReport | null>(null);
  const [healthLoading, setHealthLoading] = useState(true);
  const [pendingCount, setPendingCount] = useState<number | null>(null);
  const [pendingLoading, setPendingLoading] = useState(true);
  const [misconfigured, setMisconfigured] = useState(false);

  useEffect(() => {
    const alive = { current: true };
    adminApi
      .health()
      .then((res) => {
        if (alive.current) setHealth(res);
      })
      .catch((err: unknown) => {
        if (!alive.current) return;
        if (
          err instanceof ApiError &&
          err.code === 'BACKEND_MISCONFIGURATION'
        ) {
          setMisconfigured(true);
        } else {
          showError(
            err instanceof ApiError ? err.message : 'Failed to load health.',
          );
        }
      })
      .finally(() => {
        if (alive.current) setHealthLoading(false);
      });

    adminApi
      .listDevices({ active: false, limit: 200 })
      .then((res) => {
        if (alive.current) setPendingCount(res.items.length);
      })
      .catch((err: unknown) => {
        if (!alive.current) return;
        if (
          err instanceof ApiError &&
          err.code === 'BACKEND_MISCONFIGURATION'
        ) {
          setMisconfigured(true);
        } else {
          showError(
            err instanceof ApiError ? err.message : 'Failed to load devices.',
          );
        }
      })
      .finally(() => {
        if (alive.current) setPendingLoading(false);
      });

    return () => {
      alive.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps, @eslint-react/exhaustive-deps
  }, []);

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
        <Typography color="text.secondary" sx={{ mb: 3 }}>
          Health status unavailable.
        </Typography>
      )}

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
          <Typography variant="body2" color="text.secondary">
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
