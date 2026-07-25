import { useMemo, useState } from 'react';

import HelpOutlineIcon from '@mui/icons-material/HelpOutline';
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
import Link from '@mui/material/Link';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import type { SelectChangeEvent } from '@mui/material/Select';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';

import { useNavigate } from 'react-router-dom';

import { OpensInNewTab } from '#src/components/opens-in-new-tab';
import type { MergedProvider } from '#src/lib/admin-api';
import { adminApi } from '#src/lib/admin-api';
import { AUDIO_METER_COPY, audioMeterHref } from '#src/lib/audio-meter-url';
import { buildJoinUrl } from '#src/lib/join-url';
import { useToast } from '#src/lib/toast-context';

import { AudioMeterBar } from './audio-meter-bar';
import type {
  AudioStatus,
  FleetFilter,
  FleetRow,
  FleetStatus,
  StatusColor,
} from './fleet-status';
import {
  AUDIO_STATUS_COLOR,
  audioBySession,
  deriveAudioStatus,
  deriveSessionStatus,
  formatClippingPct,
  pipelineP95,
  setProviderKey,
  useFilteredSessions,
} from './fleet-status';
import { useFleet } from './use-fleet';

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
const AUDIO_STATUS_ORDER: AudioStatus[] = ['crit', 'warn', 'unknown', 'good'];

/**
 * Audio conventions the roll-up must label on the surface
 * (PLAN-MONITORING-DASHBOARD.md §60), matching the standalone page's wording
 * (`audio-meter.html`'s "Plain: -3.01 dBFS" reference option).
 *
 * A plain JS string, not a JSX string attribute: JSX attribute literals do not
 * process `\u`/`\n` escapes, so writing this inline renders them verbatim.
 */
const AUDIO_CONVENTIONS_TOOLTIP =
  'dBFS is plain full-scale sine (a full-scale sine reads −3.01 dBFS RMS; 0 dBFS under AES17). ' +
  'Noise floor is a 10th-percentile RMS over 1 s sub-windows, not an instantaneous floor. ' +
  'VAD fields show — when not measured, never 0.';

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
  audioCounts: Record<AudioStatus, number>;
}

const FleetFilterBar = ({
  filter,
  onChange,
  providerKeys,
  counts,
  audioCounts,
}: FleetFilterBarProps) => {
  const toggleStatus = (status: FleetStatus) => {
    const current = filter.status ?? [];
    const next = current.includes(status)
      ? current.filter((s) => s !== status)
      : [...current, status];
    onChange({ ...filter, status: next });
  };

  const toggleAudioStatus = (status: AudioStatus) => {
    const current = filter.audioStatus ?? [];
    const next = current.includes(status)
      ? current.filter((s) => s !== status)
      : [...current, status];
    onChange({ ...filter, audioStatus: next });
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
      {STATUS_ORDER.map((status) => {
        const selected = filter.status?.includes(status) ?? false;
        return (
          <Chip
            key={status}
            label={`${status} (${String(counts[status])})`}
            color={STATUS_COLOR[status]}
            variant={selected ? 'filled' : 'outlined'}
            onClick={() => {
              toggleStatus(status);
            }}
            aria-pressed={selected}
          />
        );
      })}
      <Box
        component="span"
        aria-hidden="true"
        sx={{ width: 1, height: 0, display: 'block', flexBasis: '100%' }}
      />
      {AUDIO_STATUS_ORDER.map((status) => {
        const selected = filter.audioStatus?.includes(status) ?? false;
        return (
          <Chip
            key={`audio-${status}`}
            label={`audio: ${status} (${String(audioCounts[status])})`}
            color={AUDIO_STATUS_COLOR[status]}
            variant={selected ? 'filled' : 'outlined'}
            onClick={() => {
              toggleAudioStatus(status);
            }}
            aria-pressed={selected}
          />
        );
      })}
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

const SessionCard = ({
  session,
  status,
  event,
  audio,
  audioStatus,
}: FleetRow) => {
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
              spacing={1}
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
              <Stack direction="row" spacing={0.5} flexShrink={0}>
                <Chip
                  size="small"
                  label={status}
                  color={STATUS_COLOR[status]}
                />
                <Chip
                  size="small"
                  label={`audio: ${audioStatus}`}
                  color={AUDIO_STATUS_COLOR[audioStatus]}
                  variant="outlined"
                />
              </Stack>
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
        {/*
          The audio strip sits OUTSIDE the CardActionArea deliberately. ARIA
          treats the content of a `button` as presentational, so a
          `role="progressbar"` nested inside one has its `aria-valuenow` /
          `aria-valuetext` dropped — and for this component the value *is* the
          information (SC 1.4.1: never color or graphic alone). Keeping it a
          sibling costs click-to-navigate on the strip itself and buys back the
          meter's accessible value, plus the ability to select the dBFS text.
        */}
        <CardContent sx={{ pt: 0 }}>
          {audio === undefined ? (
            <Typography variant="caption" color="error">
              {session.upstreamState === 'OPEN'
                ? 'no audio reaching ASR'
                : 'no audio telemetry'}
            </Typography>
          ) : (
            <>
              <AudioMeterBar
                rmsDbfs={audio.rmsDbfs}
                peakDbfs={audio.peakDbfs}
                status={audioStatus}
                label={`Audio level for session ${session.sessionUid}`}
              />
              <Stack
                direction="row"
                spacing={0.5}
                flexWrap="wrap"
                useFlexGap
                sx={{ mt: 0.5 }}
              >
                {audio.silence && (
                  <Chip size="small" label="silent" color="error" />
                )}
                {audio.clippingPct > 0 && (
                  <Chip
                    size="small"
                    label={`clipping ${formatClippingPct(audio.clippingPct)}`}
                    color="error"
                  />
                )}
                {audio.vadStats !== null &&
                  audio.vadStats.vadEnabled &&
                  audio.vadStats.speechActiveRatio !== null && (
                    <Chip
                      size="small"
                      label={`speech ${String(Math.round(audio.vadStats.speechActiveRatio * 100))}%`}
                      variant="outlined"
                    />
                  )}
              </Stack>
            </>
          )}
        </CardContent>
      </Card>
    </Grid>
  );
};

/**
 * Fleet audio roll-up: a stat row an operator scans first — sessions silent /
 * clipping / no-telemetry / OK. When `sessionAudio` is empty across the board,
 * this is where the "pipeline metering unavailable — use the standalone meter"
 * state and the Phase-0 link live (PLAN-MONITORING-DASHBOARD.md §6.238).
 */
const FleetAudioRollup = ({
  sessions,
  audioMap,
}: {
  sessions: FleetRow['session'][];
  audioMap: Map<string, FleetRow['audio']>;
}) => {
  const counts = useMemo(() => {
    const result: Record<AudioStatus, number> = {
      good: 0,
      warn: 0,
      crit: 0,
      unknown: 0,
    };
    for (const session of sessions) {
      const audio = audioMap.get(session.sessionUid);
      result[deriveAudioStatus(audio, session)]++;
    }
    return result;
  }, [sessions, audioMap]);

  // When no audio telemetry exists at all, point at the standalone meter.
  //
  // Keyed on the map being empty, NOT on the derived counts: `deriveAudioStatus`
  // maps "no snapshot + upstreamState OPEN" to `crit` (C1), so a count-based
  // test could never fire in the one environment this state exists for — an
  // environment with live sessions and no publisher, where every session is
  // crit. That is also why the roll-up stays rendered below rather than being
  // replaced: the operator still needs the counts, they just need to know the
  // crits mean "nothing is publishing here", not "twenty mics died at once".
  const noAudioTelemetry = sessions.length > 0 && audioMap.size === 0;

  return (
    <>
      {noAudioTelemetry && (
        <Alert severity="info" sx={{ mb: 2 }}>
          Pipeline audio metering unavailable — no audio snapshots are being
          published for any session, so the audio statuses below reflect the
          missing publisher rather than the rooms.{' '}
          <Link
            href={audioMeterHref()}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open the standalone audio meter
            <OpensInNewTab />
          </Link>
          . {AUDIO_METER_COPY}
        </Alert>
      )}

      <Stack
        direction="row"
        spacing={1}
        flexWrap="wrap"
        useFlexGap
        sx={{ mb: 2 }}
        aria-live="polite"
        aria-label="Fleet audio summary"
      >
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ alignSelf: 'center' }}
        >
          Audio:
        </Typography>
        {AUDIO_STATUS_ORDER.map((status) => (
          <Chip
            key={`rollup-${status}`}
            size="small"
            label={`${status}: ${String(counts[status])}`}
            color={AUDIO_STATUS_COLOR[status]}
            variant="outlined"
          />
        ))}
        <Tooltip title={AUDIO_CONVENTIONS_TOOLTIP}>
          <IconButton
            size="small"
            aria-label="Audio conventions"
            sx={{ alignSelf: 'center' }}
          >
            <HelpOutlineIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Stack>
    </>
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
  const audioMap = useMemo(() => audioBySession(snapshot), [snapshot]);
  const rows = useFilteredSessions(sessions, sessionEvents, audioMap, filter);

  // Unfiltered counts, so the status chips reflect the whole fleet even while
  // a status filter narrows the grid below them.
  const counts: Record<FleetStatus, number> = {
    good: 0,
    warn: 0,
    crit: 0,
    idle: 0,
  };
  const audioCounts: Record<AudioStatus, number> = {
    good: 0,
    warn: 0,
    crit: 0,
    unknown: 0,
  };
  for (const session of sessions) {
    counts[
      deriveSessionStatus(session, sessionEvents.get(session.sessionUid))
    ]++;
    audioCounts[deriveAudioStatus(audioMap.get(session.sessionUid), session)]++;
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
          <FleetAudioRollup sessions={sessions} audioMap={audioMap} />
          <FleetFilterBar
            filter={filter}
            onChange={setFilter}
            providerKeys={providerKeys}
            counts={counts}
            audioCounts={audioCounts}
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
