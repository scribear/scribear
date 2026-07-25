import { useState } from 'react';

import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardActionArea from '@mui/material/CardActionArea';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import FormControl from '@mui/material/FormControl';
import Grid from '@mui/material/Grid';
import IconButton from '@mui/material/IconButton';
import InputLabel from '@mui/material/InputLabel';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import type { SelectChangeEvent } from '@mui/material/Select';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';

import { useNavigate } from 'react-router-dom';

import type { MergedProvider } from '#src/lib/admin-api';
import { adminApi } from '#src/lib/admin-api';
import { buildJoinUrl } from '#src/lib/join-url';
import { useToast } from '#src/lib/toast-context';

import type { FleetFilter, FleetRow, FleetStatus } from './fleet-status';
import {
  deriveSessionStatus,
  pipelineP95,
  setProviderKey,
  useFilteredSessions,
} from './fleet-status';
import { useFleet } from './use-fleet';

type StatusColor = 'success' | 'warning' | 'error' | 'default';

const STATUS_COLOR: Record<FleetStatus, StatusColor> = {
  good: 'success',
  warn: 'warning',
  crit: 'error',
  idle: 'default',
};

const PROVIDER_STATUS_COLOR: Record<MergedProvider['status'], StatusColor> = {
  ok: 'success',
  degraded: 'warning',
  down: 'error',
};

const STATUS_ORDER: FleetStatus[] = ['crit', 'warn', 'good', 'idle'];

/** Merged provider health, one chip per provider (`§B.4`'s "provider row"). */
const ProviderStatusRow = ({ providers }: { providers: MergedProvider[] }) => {
  if (providers.length === 0) {
    return (
      <Typography
        variant="body2"
        sx={{
          color: 'text.secondary',
        }}
      >
        No providers reporting.
      </Typography>
    );
  }
  return (
    <Stack
      direction="row"
      spacing={1}
      useFlexGap
      sx={{
        flexWrap: 'wrap',
      }}
    >
      {providers.map((p) => (
        <Chip
          key={p.providerKey}
          label={`${p.providerKey} · ${String(p.activeSessions)}`}
          color={PROVIDER_STATUS_COLOR[p.status]}
          size="small"
        />
      ))}
    </Stack>
  );
};

interface FleetFilterBarProps {
  filter: FleetFilter;
  onChange: (filter: FleetFilter) => void;
  providerKeys: string[];
  counts: Record<FleetStatus, number>;
}

const FleetFilterBar = ({
  filter,
  onChange,
  providerKeys,
  counts,
}: FleetFilterBarProps) => {
  const toggleStatus = (status: FleetStatus) => {
    const current = filter.status ?? [];
    const next = current.includes(status)
      ? current.filter((s) => s !== status)
      : [...current, status];
    onChange({ ...filter, status: next });
  };

  return (
    <Stack
      direction="row"
      spacing={1}
      useFlexGap
      sx={{
        alignItems: 'center',
        flexWrap: 'wrap',
        mb: 2,
      }}
    >
      {STATUS_ORDER.map((status) => (
        <Chip
          key={status}
          label={`${status} (${String(counts[status])})`}
          color={STATUS_COLOR[status]}
          variant={filter.status?.includes(status) ? 'filled' : 'outlined'}
          onClick={() => {
            toggleStatus(status);
          }}
        />
      ))}
      <FormControl size="small" sx={{ minWidth: 160 }}>
        <InputLabel id="fleet-provider-filter-label">Provider</InputLabel>
        <Select
          labelId="fleet-provider-filter-label"
          label="Provider"
          value={filter.providerKey ?? ''}
          onChange={(e: SelectChangeEvent) => {
            const value = e.target.value;
            onChange(setProviderKey(filter, value === '' ? undefined : value));
          }}
        >
          <MenuItem value="">All providers</MenuItem>
          {providerKeys.map((key) => (
            <MenuItem key={key} value={key}>
              {key}
            </MenuItem>
          ))}
        </Select>
      </FormControl>
      <TextField
        size="small"
        label="Search session"
        value={filter.text ?? ''}
        onChange={(e) => {
          onChange({ ...filter, text: e.target.value });
        }}
      />
    </Stack>
  );
};

const SessionCard = ({ session, status, event }: FleetRow) => {
  const navigate = useNavigate();
  const { showError } = useToast();
  const p95 = pipelineP95(session);

  const handleOpenClient = (e: React.MouseEvent) => {
    e.stopPropagation();
    adminApi
      .getSessionJoinCode(session.sessionUid)
      .then((result) => {
        if (result.status !== 'ok' || result.joinCode === null) {
          showError('Session is not currently joinable.');
          return;
        }
        window.open(
          buildJoinUrl(result.joinCode),
          '_blank',
          'noopener,noreferrer',
        );
      })
      .catch(() => {
        showError('Failed to fetch join code.');
      });
  };

  return (
    <Grid size={{ xs: 12, sm: 6, md: 4, lg: 3 }}>
      <Card variant="outlined" sx={{ position: 'relative' }}>
        <IconButton
          size="small"
          onClick={handleOpenClient}
          aria-label="Open live captions"
          sx={{
            position: 'absolute',
            top: 4,
            right: 4,
            zIndex: 1,
            bgcolor: 'background.paper',
          }}
        >
          <OpenInNewIcon fontSize="small" />
        </IconButton>
        <CardActionArea
          onClick={() => {
            void navigate(`/sessions/${session.sessionUid}`);
          }}
        >
          <CardContent>
            <Stack
              direction="row"
              sx={{
                justifyContent: 'space-between',
                alignItems: 'flex-start',
              }}
            >
              <Typography
                variant="body2"
                sx={{ fontFamily: 'monospace', wordBreak: 'break-all' }}
              >
                {session.sessionUid}
              </Typography>
              <Chip size="small" label={status} color={STATUS_COLOR[status]} />
            </Stack>
            <Typography
              variant="caption"
              sx={{
                color: 'text.secondary',
                display: 'block',
                fontFamily: 'monospace',
              }}
            >
              room: {session.roomUid ?? 'no room'}
            </Typography>
            <Typography
              variant="body2"
              sx={{
                color: 'text.secondary',
                mt: 1,
              }}
            >
              {session.providerKey}
            </Typography>
            <Typography
              variant="caption"
              sx={{
                color: 'text.secondary',
              }}
            >
              {session.upstreamState}
              {event &&
                !event.sourceDeviceConnected &&
                ' · source disconnected'}
              {event &&
                !event.transcriptionServiceConnected &&
                ' · ASR disconnected'}
            </Typography>
            {p95 !== null && (
              <Typography
                variant="caption"
                sx={{
                  color: 'text.secondary',
                  display: 'block',
                }}
              >
                pipeline p95 {Math.round(p95)}ms
              </Typography>
            )}
          </CardContent>
        </CardActionArea>
      </Card>
    </Grid>
  );
};

/**
 * Live fleet view for the dashboard: a provider status row plus a
 * filter/sort/status grid of every active session (`PLAN-fleet-and-testaudio.md`
 * §B.4, adapted to session-centric telemetry — see `fleet-status.ts`).
 */
export const FleetPanel = () => {
  const { snapshot, sessionEvents, connected, available } = useFleet();
  const [filter, setFilter] = useState<FleetFilter>({
    status: ['crit', 'warn'],
  });

  const sessions = snapshot?.sessions ?? [];
  const rows = useFilteredSessions(sessions, sessionEvents, filter);

  // Unfiltered counts, so the status chips reflect the whole fleet even while
  // a status filter narrows the grid below them.
  const counts: Record<FleetStatus, number> = {
    good: 0,
    warn: 0,
    crit: 0,
    idle: 0,
  };
  for (const session of sessions) {
    counts[
      deriveSessionStatus(session, sessionEvents.get(session.sessionUid))
    ]++;
  }

  const providerKeys = [...new Set(sessions.map((s) => s.providerKey))].sort();

  if (!available) {
    return (
      <Alert severity="info" sx={{ mb: 3 }}>
        Live telemetry not configured — an operator must set{' '}
        <code>REDIS_URL</code> to enable the fleet view.
      </Alert>
    );
  }

  return (
    <Box sx={{ mb: 3 }}>
      <Stack
        direction="row"
        sx={{
          justifyContent: 'space-between',
          alignItems: 'center',
          mb: 1,
        }}
      >
        <Typography variant="h6" component="h2">
          Live fleet
        </Typography>
        {!connected && (
          <Chip size="small" label="reconnecting…" color="warning" />
        )}
      </Stack>
      <Box sx={{ mb: 2 }}>
        <ProviderStatusRow providers={snapshot?.providers ?? []} />
      </Box>
      {snapshot === null ? (
        <Typography
          sx={{
            color: 'text.secondary',
          }}
        >
          Loading fleet…
        </Typography>
      ) : sessions.length === 0 ? (
        <Typography
          sx={{
            color: 'text.secondary',
          }}
        >
          No active sessions.
        </Typography>
      ) : (
        <>
          <FleetFilterBar
            filter={filter}
            onChange={setFilter}
            providerKeys={providerKeys}
            counts={counts}
          />
          {rows.length === 0 ? (
            <Typography
              sx={{
                color: 'text.secondary',
              }}
            >
              No sessions match the current filter.
            </Typography>
          ) : (
            <Grid container spacing={2}>
              {rows.map((row) => (
                <SessionCard key={row.session.sessionUid} {...row} />
              ))}
            </Grid>
          )}
        </>
      )}
    </Box>
  );
};
