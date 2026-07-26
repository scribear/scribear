import { useMemo, useState } from 'react';

import HelpOutlineIcon from '@mui/icons-material/HelpOutlined';
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

import { AudioMeterBar, PEAK_CONVENTION } from './audio-meter-bar';
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
  headlineStage,
  headlineVadStats,
  pipelineP95,
  setProviderKey,
  sourceThroughputSeconds,
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
  'Levels are RMS over a 10 s window, plain full-scale reference (a full-scale sine reads −3.01 dBFS RMS; 0 dBFS under AES17). ' +
  'Noise floor is a 10th-percentile RMS over 1 s sub-windows, not an instantaneous floor. ' +
  `${PEAK_CONVENTION} ` +
  'Clipping counts samples at or above 0.99 of full scale in runs of at least two. ' +
  'VAD fields show — when not measured, never 0. ' +
  'Levels are read at the measurement point closest to the source, so a green audio ' +
  'chip says the source is sending good audio — a stalled ASR shows on the ' +
  'connectivity chip and in the per-stage gap on the session page, not here.';

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
  // One shared choice of "the" reading (§12.6): the lowest-depth stage carrying
  // levels, the same stage `deriveAudioStatus` classified to produce the chip
  // above. Picking it here independently would let the bar and the chip
  // disagree on a graph with several metering points.
  const headline = audio === undefined ? undefined : headlineStage(audio);
  const vadStats = audio === undefined ? null : headlineVadStats(audio);
  const throughputSeconds =
    audio === undefined ? null : sourceThroughputSeconds(audio);

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
    // `sm: 6` used to give two 12-wide columns at the sm breakpoint, but
    // `AppLayout`'s sidebar is a fixed ~232px at every viewport width (it does
    // not collapse below `md`), so a 600px viewport leaves ~320px of grid
    // content — two columns there means ~150px cards, well under the ~180px
    // the audio strip (bar `minWidth: 60` + gap + the dBFS readout's `4.5em`
    // + CardContent padding) needs. `md`/`lg` already give a wide enough card
    // (measured ~196px+ in a real browser) and are left alone. Staying single
    // column through the whole `sm` range (320-620px of content) trades grid
    // density for a card that never has to fit two things into one column's
    // width.
    <Grid size={{ xs: 12, sm: 12, md: 4, lg: 3 }}>
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
              useFlexGap
              sx={{
                justifyContent: 'space-between',
                alignItems: 'flex-start',
                // A real (UUID) session UID and the status/audio chips are
                // both rigid content competing for one line: the chips carry
                // `flexShrink: 0` (their labels must stay whole, D1 below),
                // so on a card too narrow for both, flexbox had nowhere to
                // take the space from except the UID — squeezing it down
                // past its longest unbreakable hyphen segment and forcing a
                // real horizontal overflow past the card edge (visible as
                // the audio chip's tail sitting under the neighbouring
                // grid cell / icon button). `flexWrap: 'wrap'` lets the chip
                // group drop to its own line instead, so the UID always gets
                // either the full row (chips wrapped below) or a row with
                // real spare width (chips fit beside it) — never a width
                // narrower than its own content demands.
                flexWrap: 'wrap',
                rowGap: 0.5,
                // Clearance for the absolutely-positioned "Open live captions"
                // button above, which has an opaque background and a higher
                // z-index: without it the button paints over the last ~18px of
                // this row, and since the audio chip is the rightmost thing in
                // it, "audio: good" rendered as "audio: goo". Measured in a
                // browser at every breakpoint — the chip is the text half of
                // "never colour alone" (D1), so it has to be readable whole.
                pr: 2.5,
              }}
            >
              <Typography
                variant="body2"
                sx={{
                  fontFamily: 'monospace',
                  // `break-all` allows a break between *any* two characters,
                  // which the flex-item min-content calculation takes
                  // literally: the browser sizes this item's floor as one
                  // glyph wide, so a narrow card (or, before the Grid change
                  // above, every card at `sm`) rendered the UID one character
                  // per line. `overflow-wrap: break-word` breaks only when a
                  // run genuinely does not fit, and — unlike `break-all` — it
                  // does not enter the min-content calculation, so it does
                  // not force the item to shrink pre-emptively. Session UIDs
                  // are UUIDs, so the hyphens already give the browser a
                  // normal break opportunity every 4-12 characters; nothing
                  // here hides a character, it only ever adds a line break.
                  overflowWrap: 'break-word',
                }}
              >
                {session.sessionUid}
              </Typography>
              <Stack direction="row" spacing={0.5} sx={{ flexShrink: 0 }}>
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
                ? session.audioFramesReceived !== undefined &&
                  session.audioFramesReceived > 0
                  ? 'audio received, not reaching ASR'
                  : 'no audio from source'
                : 'no audio telemetry'}
            </Typography>
          ) : headline === undefined ? (
            /*
              A snapshot arrived, but no measurement point in it reports levels
              — a provider that counts throughput only (§12.3: `debug` reports
              `asr_input` with seconds and no meter). Saying so is the whole
              point: an empty strip reads as "nothing to report" and a bar at
              rest reads as silence, and both are the false-green §12.8 point 1
              forbids. The seconds count, when there is one, is the honest
              signal available here — audio is demonstrably flowing.
            */
            <Typography variant="caption" color="text.secondary">
              metering unavailable for this provider
              {throughputSeconds !== null &&
                ` · ${throughputSeconds.toFixed(1)} s of audio counted`}
            </Typography>
          ) : (
            <>
              <AudioMeterBar
                rmsDbfs={headline.levels.rmsDbfs}
                peakDbfs={headline.levels.peakDbfs}
                status={audioStatus}
                label={`Audio level for session ${session.sessionUid} at ${headline.label}`}
              />
              <Stack
                direction="row"
                spacing={0.5}
                useFlexGap
                sx={{ flexWrap: 'wrap', mt: 0.5 }}
              >
                {headline.levels.silence && (
                  <Chip size="small" label="silent" color="error" />
                )}
                {headline.levels.clippingPct > 0 && (
                  <Chip
                    size="small"
                    label={`clipping ${formatClippingPct(headline.levels.clippingPct)}`}
                    color="error"
                  />
                )}
                {vadStats !== null &&
                  vadStats.vadEnabled &&
                  vadStats.speechActiveRatio !== null && (
                    <Chip
                      size="small"
                      label={`speech ${String(Math.round(vadStats.speechActiveRatio * 100))}%`}
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
        useFlexGap
        sx={{ flexWrap: 'wrap', mb: 2 }}
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
