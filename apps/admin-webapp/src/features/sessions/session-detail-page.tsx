import type { ReactNode } from 'react';
import { useEffect, useMemo, useState } from 'react';

import HelpOutlineIcon from '@mui/icons-material/HelpOutlined';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import ReportProblemIcon from '@mui/icons-material/ReportProblem';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import Link from '@mui/material/Link';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';

import { Link as RouterLink, useParams } from 'react-router-dom';

import type { Room, Session } from '@scribear/session-manager-schema';

import { ConfirmDialog } from '#src/components/confirm-dialog';
import { CopyIconButton } from '#src/components/copy-icon-button';
import { OpensInNewTab } from '#src/components/opens-in-new-tab';
import { TimezoneNote } from '#src/components/timezone-note';
import {
  AudioMeterBar,
  PEAK_CONVENTION,
} from '#src/features/dashboard/audio-meter-bar';
import type { StageEdge } from '#src/features/dashboard/fleet-status';
import {
  AUDIO_STATUS_COLOR,
  AUDIO_THRESHOLDS,
  audioBySession,
  classifyAudioSnapshot,
  deriveStageEdges,
  formatClippingPct,
  headlineStage,
  headlineVadStats,
  stagesByDepth,
  vadStage,
} from '#src/features/dashboard/fleet-status';
import { useFleet } from '#src/features/dashboard/use-fleet';
import type {
  AudioStage,
  SessionAudioSnapshot,
  SessionJoinCodeStatus,
  VadStats,
} from '#src/lib/admin-api';
import { AUDIO_STATS_TTL_MS, adminApi } from '#src/lib/admin-api';
import { ApiError, isApiErrorCode } from '#src/lib/api-error';
import {
  AUDIO_METER_COPY,
  audioMeterAbsoluteUrl,
} from '#src/lib/audio-meter-url';
import { buildJoinUrl } from '#src/lib/join-url';
import {
  canCancel,
  canEndEarly,
  canStartEarly,
  sessionWindowState,
} from '#src/lib/session-rules';
import { formatInTimeZone } from '#src/lib/timezone';
import { useToast } from '#src/lib/toast-context';
import { useAsyncData } from '#src/lib/use-async-data';

// Join codes rotate on a ~5 minute window server-side; re-poll well inside
// that so the "Open live captions" link stays exchangeable without a manual
// page refresh — mirrors the demo-room card's poll cadence.
const JOIN_CODE_POLL_MS = 120_000;

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

function formatDateTime(
  iso: string | null,
  timeZone: string | undefined,
): string {
  if (iso === null) return '—';
  return timeZone === undefined
    ? new Date(iso).toLocaleString()
    : formatInTimeZone(iso, timeZone);
}

/** YYYY-MM-DD from an ISO instant, for the `?date=` calendar deep link. */
function dateOnly(iso: string): string {
  return iso.slice(0, 10);
}

interface FieldRowProps {
  label: string;
  children: ReactNode;
}

const FieldRow = ({ label, children }: FieldRowProps) => (
  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
    <Typography
      variant="body2"
      sx={{
        color: 'text.secondary',
        minWidth: 160,
      }}
    >
      {label}
    </Typography>
    {children}
  </Box>
);

/** Formats an epoch-ms timestamp as a relative age, e.g. "4 s ago". */
function formatAge(updatedAt: number, now: number): string {
  const sec = Math.max(0, Math.round((now - updatedAt) / 1000));
  if (sec < 60) return `${String(sec)} s ago`;
  const min = Math.floor(sec / 60);
  return `${String(min)} min ago`;
}

/**
 * Renders a VAD field with the three-state semantics from §6.2 of
 * PLAN-AUDIOVIZ: **value**, **"not measured"** (em-dash + tooltip), and
 * **"no signal"** — never `0` when the meaning is "not measured".
 *
 * - `vadStats === null` or `vadEnabled === false` → "not measured"
 * - field value is `null` → "not measured" (structural: no segments, no signal side, etc.)
 * - otherwise → the value
 */
function vadFieldValue(
  vadStats: VadStats | null,
  field: keyof Omit<VadStats, 'vadEnabled'>,
  format: (v: number) => string,
): { text: string; notMeasured: boolean; tooltip: string } {
  if (vadStats === null) {
    return {
      text: '—',
      notMeasured: true,
      tooltip: 'VAD stats were not produced for this batch.',
    };
  }
  if (!vadStats.vadEnabled) {
    return {
      text: '—',
      notMeasured: true,
      tooltip: 'VAD was not enabled, so this field was not measured.',
    };
  }
  const value = vadStats[field];
  if (value === null) {
    const tooltips: Record<string, string> = {
      speechActiveRatio: 'Not measured.',
      segmentCount: 'Not measured.',
      meanSegmentDurationSec:
        'No segments were found, so there is no mean to compute.',
      speechToPauseRatio:
        'speechActiveRatio is 1.0 (all speech, no pause), so the ratio is undefined.',
      snrDb:
        'The buffer read as 0% or 100% speech, so one side of the comparison has no samples.',
    };
    return {
      text: '—',
      notMeasured: true,
      tooltip: tooltips[field] ?? 'Not measured.',
    };
  }
  return { text: format(value), notMeasured: false, tooltip: '' };
}

/**
 * The "not measured" state from §6.2: an em-dash that can tell you *why*.
 *
 * One component rather than the pattern repeated per surface, because the whole
 * point of the three-state rendering is that the third state is never silently
 * collapsed into the second — and a surface that reimplements it is a surface
 * that can forget the reason.
 *
 * `tabIndex` makes the em-dash focusable so keyboard users can trigger the
 * tooltip (SC 2.1.1); without it the reason is available to pointer users only.
 */
const NotMeasured = ({ reason }: { reason: string }) => (
  <Tooltip title={reason}>
    <Typography
      component="span"
      variant="body2"
      tabIndex={0}
      sx={{ cursor: 'help', outlineOffset: 2 }}
    >
      —
    </Typography>
  </Tooltip>
);

const VadFieldRow = ({
  label,
  vadStats,
  field,
  format,
}: {
  label: string;
  vadStats: VadStats | null;
  field: keyof Omit<VadStats, 'vadEnabled'>;
  format: (v: number) => string;
}) => {
  const { text, notMeasured, tooltip } = vadFieldValue(vadStats, field, format);
  return (
    <FieldRow label={label}>
      {notMeasured ? (
        <NotMeasured reason={tooltip} />
      ) : (
        <Typography variant="body2">{text}</Typography>
      )}
    </FieldRow>
  );
};

/**
 * Conventions this readout depends on, stated where the number is
 * (PLAN-AUDIOVIZ §8: "audio conventions must be labelled on the surface").
 *
 * Each is a measurement definition an operator cannot infer from the figure, and
 * that differs from what the standalone meter shows most prominently — so
 * comparing the two surfaces without them invites a wrong conclusion.
 */
const RMS_CONVENTION =
  'RMS over the 10 s metering window, plain full-scale reference: a full-scale ' +
  'sine reads −3.01 dBFS (0 dBFS under AES17).';

const NOISE_FLOOR_CONVENTION =
  'Noise floor is the 10th-percentile RMS across 1 s sub-windows of the ' +
  'metering window — an ambient estimate, not an instantaneous floor, so it ' +
  'does not drop to silence between words.';

const CLIPPING_CONVENTION =
  'Clipping counts samples at or above 0.99 of full scale in runs of at least ' +
  'two consecutive samples. A waveform that merely touches full scale is not ' +
  'clipped; a flat run at the rail is.';

/**
 * A focusable footnote marker carrying a measurement convention.
 *
 * An `IconButton` rather than a `tabIndex`-ed span so it is keyboard-operable
 * natively (SC 2.1.1), and the convention is the button's `aria-label` rather
 * than only the tooltip: MUI wires a tooltip up via `aria-describedby` only
 * while it is open, so a screen-reader user who never triggers it would
 * otherwise never hear the text.
 */
const ConventionNote = ({ convention }: { convention: string }) => (
  <Tooltip title={convention}>
    <IconButton
      size="small"
      aria-label={convention}
      sx={{ p: 0.25, ml: 0.5, color: 'text.secondary' }}
    >
      <HelpOutlineIcon sx={{ fontSize: '0.95rem' }} />
    </IconButton>
  </Tooltip>
);

const PIPELINE_CONVENTION =
  'Each row is one measurement point that reported for this session, ordered ' +
  'from the source down. Seconds are cumulative totals past that point, not ' +
  'rates, so they subtract cleanly across an edge — which is what makes the ' +
  '"change from upstream" column meaningful. A difference under ' +
  `${String(AUDIO_THRESHOLDS.signalLossToleranceSec)} s is normal: the two ` +
  'counters are read at different instants, and a worker’s total only ' +
  'advances when a job runs.';

const GATED_CONVENTION =
  'A voice-activity detector is supposed to pass on less audio than it ' +
  'received, so the drop across a detector is gating, not loss. A large gated ' +
  'figure is still worth reading — it can mean over-aggressive gating, a ' +
  'detector eating the room — but it is a different claim from "the pipeline ' +
  'dropped audio".';

/** Reasons a cell is an em-dash. Each names the measurement point's own
 *  limitation, never a failure — §6.2: nullability is meaning, not absence. */
const NO_LEVELS_REASON =
  'This measurement point counts throughput only and reports no levels — not a failed measurement.';
const NO_SECONDS_REASON =
  'This measurement point does not count seconds of audio.';
const NO_DETECTOR_REASON =
  'This measurement point runs no voice-activity detector.';
const DETECTOR_OFF_REASON =
  'A detector exists for this stage but did not run, so speech was not measured. This is not 0% speech.';
const SOURCE_STAGE_REASON =
  'A source measurement point — nothing upstream of it reported, so there is nothing to compare against.';
const EDGE_NOT_DERIVABLE_REASON =
  'One end of this edge does not count seconds, so the comparison is not derivable. Showing 0 would be a claim the data does not support.';

/** Renders one derivable edge's `audioSeconds` comparison as words plus a
 *  figure — never colour alone (SC 1.4.1), so "lost" and "gated" are readable
 *  without seeing that one of them is red. */
function formatStageEdge(edge: StageEdge): string {
  const seconds = `${Math.abs(edge.differenceSeconds).toFixed(1)} s`;
  switch (edge.kind) {
    case 'loss':
      return `${seconds} lost from ${edge.fromStage}`;
    case 'gated':
      return `${seconds} gated from ${edge.fromStage}`;
    case 'within-tolerance':
    default:
      return `${seconds} vs ${edge.fromStage}, within tolerance`;
  }
}

/** Speech-active percentage for a stage, with §6.2's three states. */
const StageVadCell = ({ stage }: { stage: AudioStage }) => {
  if (stage.vad === null) return <NotMeasured reason={NO_DETECTOR_REASON} />;
  if (!stage.vad.vadEnabled) {
    return <NotMeasured reason={DETECTOR_OFF_REASON} />;
  }
  if (stage.vad.speechActiveRatio === null) {
    return (
      <NotMeasured reason="Speech ratio was not reported for this batch." />
    );
  }
  return (
    <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>
      {String(Math.round(stage.vad.speechActiveRatio * 100))}% speech
    </Typography>
  );
};

/**
 * The "dynamic view of the processing pipeline" this change exists to enable
 * (§12.6): every measurement point the session reported, grouped by depth, with
 * the per-edge `audioSeconds` comparison that answers *where* audio was lost.
 *
 * A real `<table>` with real header cells, not a div grid: the rows are a data
 * relation an operator reads across, and a screen-reader user needs the column
 * header announced with each cell. A `<caption>` rather than an `aria-label`, so
 * the explanation of what the numbers mean is available to everyone rather than
 * only to assistive tech.
 *
 * Deliberately **no `aria-live`** on any of it. §8 puts the live region on the
 * fleet roll-up alone: these figures change on every 5 s poll, and a region that
 * re-announces a table of dBFS and second counts is unusable. That is also why
 * flagged loss is a coloured icon and the word "lost" in the cell rather than an
 * `Alert` — MUI's `Alert` carries `role="alert"`, i.e. an assertive live region,
 * which would announce every poll.
 *
 * A full arrow-drawn graph is buildable from `inputs` and is not required here
 * (§12.6); the "fed by" column carries the same edges in text.
 */
const StagePipelineTable = ({ audio }: { audio: SessionAudioSnapshot }) => {
  const groups = stagesByDepth(audio);
  const headline = headlineStage(audio);

  // Edges indexed by their downstream stage, so each row shows the comparison
  // for the audio arriving *at* it. A stage with two inputs gets two figures —
  // attribution to a specific edge is the point (§12.2: a bare depth integer
  // could not do this).
  const edgesByDownstream = new Map<string, StageEdge[]>();
  for (const edge of deriveStageEdges(audio)) {
    const existing = edgesByDownstream.get(edge.toStage);
    if (existing === undefined) {
      edgesByDownstream.set(edge.toStage, [edge]);
    } else {
      existing.push(edge);
    }
  }

  if (groups.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary">
        No measurement points reported for this session yet.
      </Typography>
    );
  }

  return (
    <TableContainer sx={{ overflowX: 'auto' }}>
      <Table size="small">
        <Box
          component="caption"
          sx={{ captionSide: 'top', textAlign: 'left', px: 0, pb: 1 }}
        >
          <Typography variant="caption" color="text.secondary">
            Audio pipeline measurement points, from the source down.{' '}
            {PIPELINE_CONVENTION}
          </Typography>
        </Box>
        <TableHead>
          <TableRow>
            <TableCell component="th" scope="col">
              Stage
            </TableCell>
            <TableCell component="th" scope="col">
              Depth
            </TableCell>
            <TableCell component="th" scope="col">
              Fed by
            </TableCell>
            <TableCell component="th" scope="col">
              Levels (RMS / peak)
            </TableCell>
            <TableCell component="th" scope="col">
              Speech
            </TableCell>
            <TableCell component="th" scope="col">
              Audio counted
            </TableCell>
            <TableCell component="th" scope="col">
              Change from upstream
            </TableCell>
          </TableRow>
        </TableHead>
        {groups.map((group) => (
          // One tbody per depth: the grouping §12.6 asks for, expressed in
          // markup rather than only in row order, so it survives a reader that
          // navigates by row group.
          <TableBody key={group.depth}>
            {group.stages.map((stage) => {
              const edges = edgesByDownstream.get(stage.stage) ?? [];
              return (
                <TableRow key={stage.stage}>
                  <TableCell component="th" scope="row">
                    <Typography variant="body2">{stage.label}</Typography>
                    <Typography
                      variant="caption"
                      color="text.secondary"
                      sx={{ fontFamily: 'monospace', display: 'block' }}
                    >
                      {stage.stage}
                    </Typography>
                    {headline?.stage === stage.stage && (
                      <Chip
                        size="small"
                        variant="outlined"
                        label="status source"
                        sx={{ mt: 0.5 }}
                      />
                    )}
                  </TableCell>
                  <TableCell>{String(stage.depth)}</TableCell>
                  <TableCell>
                    {stage.inputs.length === 0 ? (
                      <NotMeasured reason={SOURCE_STAGE_REASON} />
                    ) : (
                      <Typography
                        variant="body2"
                        sx={{ fontFamily: 'monospace' }}
                      >
                        {stage.inputs.join(', ')}
                      </Typography>
                    )}
                  </TableCell>
                  <TableCell>
                    {stage.levels === null ? (
                      <NotMeasured reason={NO_LEVELS_REASON} />
                    ) : (
                      <>
                        <Typography
                          variant="body2"
                          sx={{ fontFamily: 'monospace' }}
                        >
                          {stage.levels.rmsDbfs.toFixed(1)} /{' '}
                          {stage.levels.peakDbfs.toFixed(1)} dBFS
                        </Typography>
                        {stage.levels.clippingPct > 0 && (
                          <Typography variant="caption" color="error">
                            clipping{' '}
                            {formatClippingPct(stage.levels.clippingPct)}
                          </Typography>
                        )}
                      </>
                    )}
                  </TableCell>
                  <TableCell>
                    <StageVadCell stage={stage} />
                  </TableCell>
                  <TableCell>
                    {stage.audioSeconds === null ? (
                      <NotMeasured reason={NO_SECONDS_REASON} />
                    ) : (
                      <Typography
                        variant="body2"
                        sx={{ fontFamily: 'monospace' }}
                      >
                        {stage.audioSeconds.toFixed(1)} s
                      </Typography>
                    )}
                  </TableCell>
                  <TableCell>
                    {edges.length === 0 ? (
                      <NotMeasured
                        reason={
                          stage.inputs.length === 0
                            ? SOURCE_STAGE_REASON
                            : EDGE_NOT_DERIVABLE_REASON
                        }
                      />
                    ) : (
                      <Stack spacing={0.25}>
                        {edges.map((edge) => (
                          <Stack
                            key={`${edge.fromStage}->${edge.toStage}`}
                            direction="row"
                            spacing={0.5}
                            sx={{ alignItems: 'center' }}
                          >
                            {edge.kind === 'loss' && (
                              <ReportProblemIcon
                                color="error"
                                sx={{ fontSize: '1rem' }}
                                aria-hidden="true"
                              />
                            )}
                            <Typography
                              variant="body2"
                              color={
                                edge.kind === 'loss' ? 'error' : 'text.primary'
                              }
                            >
                              {formatStageEdge(edge)}
                            </Typography>
                            {edge.kind === 'gated' && (
                              <ConventionNote convention={GATED_CONVENTION} />
                            )}
                          </Stack>
                        ))}
                      </Stack>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        ))}
      </Table>
    </TableContainer>
  );
};

/** Section shell, so every audio-health state renders the same heading. */
const AudioHealthPaper = ({ children }: { children: ReactNode }) => (
  <Paper variant="outlined" sx={{ p: 3, mb: 3 }}>
    <Typography variant="h6" component="h2" sx={{ mb: 2 }}>
      Audio health
    </Typography>
    {children}
  </Paper>
);

/** The meter link plus its copy button and the "run it on the source machine"
 *  caveat — the same affordance in every audio-health state. */
const StandaloneMeterLink = () => (
  <>
    <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
      <Button
        variant="outlined"
        size="small"
        component="a"
        href={audioMeterAbsoluteUrl()}
        target="_blank"
        rel="noopener noreferrer"
        startIcon={<OpenInNewIcon />}
      >
        Open standalone audio meter
        <OpensInNewTab />
      </Button>
      <CopyIconButton value={audioMeterAbsoluteUrl()} label="audio meter URL" />
    </Stack>
    <Typography
      variant="caption"
      color="text.secondary"
      sx={{ mt: 1, display: 'block' }}
    >
      {AUDIO_METER_COPY}
    </Typography>
  </>
);

/**
 * Audio health for a session inside its scheduled window. Uses `useFleet()` to
 * get the latest audio snapshot (PLAN-AUDIOVIZ §7.4, open question §10.3: a
 * per-session endpoint may be cleaner if the detail page is expected to be left
 * open — this pulls the whole fleet snapshot on the fleet poll interval).
 *
 * Split out from `AudioHealthSection` so that subscription happens *only* while
 * the session could plausibly be on the air: hooks cannot be called
 * conditionally, so the window check has to gate which component renders.
 */
const LiveAudioHealth = ({
  sessionUid,
  now,
}: {
  sessionUid: string;
  now: number;
}) => {
  const { snapshot, available } = useFleet();
  const audioMap = useMemo(() => audioBySession(snapshot), [snapshot]);
  const audio = audioMap.get(sessionUid);

  if (!available) {
    return (
      <AudioHealthPaper>
        <Typography variant="body2" color="text.secondary">
          Live telemetry not configured — audio health requires{' '}
          <code>REDIS_URL</code>.
        </Typography>
      </AudioHealthPaper>
    );
  }

  if (audio === undefined) {
    return (
      <AudioHealthPaper>
        {/* Only reached inside the session's scheduled window, so the absence
            really is failure mode C1 rather than "this session isn't on". */}
        <Alert severity="warning" sx={{ mb: 2 }}>
          No audio telemetry for this session, which is inside its scheduled
          window — nothing has decoded audio for it in the last{' '}
          {Math.round(AUDIO_STATS_TTL_MS / 1000)} s. Check that the source
          device&rsquo;s microphone is unmuted and the right input is selected.
        </Alert>
        <StandaloneMeterLink />
      </AudioHealthPaper>
    );
  }

  const age = formatAge(audio.updatedAt, now);
  const stale = now - audio.updatedAt > AUDIO_STATS_TTL_MS;
  // The headline stage (§12.6) — the lowest-depth point carrying levels, i.e.
  // the measurement closest to the source. The same choice `classifyAudioSnapshot`
  // makes for the chip, taken from one shared helper so this readout cannot
  // describe a different stage from the one the status came from.
  const headline = headlineStage(audio);
  const vad = headlineVadStats(audio);
  const detector = vadStage(audio);
  const audioStatus = classifyAudioSnapshot(audio);

  return (
    <Paper variant="outlined" sx={{ p: 3, mb: 3 }}>
      <Stack
        direction="row"
        sx={{ justifyContent: 'space-between', alignItems: 'center', mb: 2 }}
      >
        <Typography variant="h6" component="h2">
          Audio health
        </Typography>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
          <Chip
            size="small"
            label={`audio: ${audioStatus}`}
            color={AUDIO_STATUS_COLOR[audioStatus]}
          />
          <Tooltip
            title={
              stale
                ? `Last updated ${age} — stale (older than ${String(Math.round(AUDIO_STATS_TTL_MS / 1000))} s)`
                : `Last updated ${age}`
            }
          >
            <Typography
              variant="caption"
              color={stale ? 'error' : 'text.secondary'}
              tabIndex={0}
              sx={{ outlineOffset: 2 }}
            >
              {age}
            </Typography>
          </Tooltip>
        </Stack>
      </Stack>

      {stale && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          Audio reading is stale — no update for more than{' '}
          {Math.round(AUDIO_STATS_TTL_MS / 1000)} s.
        </Alert>
      )}

      {headline === undefined ? (
        /*
          A snapshot exists and no measurement point in it reports levels — the
          `debug` provider's shape (§12.3), and any deployment whose provider
          counts throughput without metering. Saying so beats a bar at rest,
          which reads as silence (§12.8 point 1). The pipeline table below still
          renders: seconds per stage is exactly what this provider *does* report,
          and it is enough to answer "is audio flowing and where does it go".
        */
        <Alert severity="info" sx={{ mb: 2 }}>
          Pipeline metering unavailable for this session&rsquo;s provider — it
          reports throughput but no levels, so there is no dBFS reading to
          judge. Use the standalone meter on the source machine to check the
          room, and the stage table below to confirm audio is reaching the ASR.
        </Alert>
      ) : (
        <Stack spacing={1.5} sx={{ mb: 2 }}>
          <Box>
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ mb: 0.5, display: 'block' }}
            >
              RMS level, with the window peak marked — measured at{' '}
              {headline.label}
            </Typography>
            <AudioMeterBar
              rmsDbfs={headline.levels.rmsDbfs}
              peakDbfs={headline.levels.peakDbfs}
              status={audioStatus}
              label={`Audio level for session ${sessionUid} at ${headline.label}`}
            />
          </Box>
          <FieldRow label="RMS (10 s window)">
            <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>
              {headline.levels.rmsDbfs.toFixed(1)} dBFS
            </Typography>
            <ConventionNote convention={RMS_CONVENTION} />
          </FieldRow>
          {/* "window max", not a bare "Peak": the standalone meter's headline
              Peak is a hold-and-decay meter and reads lower on the same audio. */}
          <FieldRow label="Peak (10 s window max)">
            <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>
              {headline.levels.peakDbfs.toFixed(1)} dBFS
            </Typography>
            <ConventionNote convention={PEAK_CONVENTION} />
          </FieldRow>
          <FieldRow label="Clipping">
            <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>
              {formatClippingPct(headline.levels.clippingPct)}
            </Typography>
            <ConventionNote convention={CLIPPING_CONVENTION} />
          </FieldRow>
          <FieldRow label="Silence">
            <Typography variant="body2">
              {headline.levels.silence ? 'Yes' : 'No'}
            </Typography>
          </FieldRow>
          <FieldRow label="Noise floor">
            <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>
              {headline.levels.noiseFloorDbfs.toFixed(1)} dBFS
            </Typography>
            <ConventionNote convention={NOISE_FLOOR_CONVENTION} />
          </FieldRow>
          {/* Which point produced the figures above. §12.8 point 1 is a
              behaviour change to a shipped signal — a green chip now asserts
              "the source is sending good audio" and nothing about the ASR — and
              an operator can only know that if the surface says where it looked. */}
          <FieldRow label="Measured at">
            <Typography variant="body2">
              {headline.label} (depth {String(headline.depth)})
            </Typography>
          </FieldRow>
          <FieldRow label="Transcription host">
            <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>
              {audio.transcriptionHost}
            </Typography>
          </FieldRow>
        </Stack>
      )}

      <Divider sx={{ mb: 2 }} />

      {/* `component="h3"` is load-bearing: MUI maps the `subtitle2` *variant* to
          an `<h6>` element, which under this section's `<h2>` skips four levels
          and fails axe's heading-order rule. This is a real subsection of Audio
          health, so h3 is both valid and the correct semantics. */}
      <Typography variant="subtitle2" component="h3" sx={{ mb: 1 }}>
        Processing pipeline
      </Typography>
      <StagePipelineTable audio={audio} />

      <Divider sx={{ my: 2 }} />

      <Typography variant="subtitle2" component="h3" sx={{ mb: 1 }}>
        VAD statistics
        {detector !== undefined && (
          <Typography
            component="span"
            variant="caption"
            color="text.secondary"
            sx={{ ml: 1 }}
          >
            at {detector.label}
          </Typography>
        )}
      </Typography>
      {vad === null ? (
        /* No stage in the graph carries a detector at all — §12.3: only whisper
           reports a `vad` stage. Distinct from `vadEnabled: false`, which means a
           detector exists for this stage and did not run. */
        <Typography variant="body2" color="text.secondary">
          No measurement point in this pipeline runs a voice-activity detector.
        </Typography>
      ) : !vad.vadEnabled ? (
        <Typography variant="body2" color="text.secondary">
          VAD was not enabled for this session.
        </Typography>
      ) : (
        <Stack spacing={1.5}>
          <FieldRow label="Speech active">
            <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>
              {vad.speechActiveRatio !== null
                ? `${String(Math.round(vad.speechActiveRatio * 100))}%`
                : '—'}
            </Typography>
          </FieldRow>
          <VadFieldRow
            label="Segments"
            vadStats={vad}
            field="segmentCount"
            format={(v) => String(v)}
          />
          <VadFieldRow
            label="Mean segment"
            vadStats={vad}
            field="meanSegmentDurationSec"
            format={(v) => `${v.toFixed(2)} s`}
          />
          <VadFieldRow
            label="Speech/pause ratio"
            vadStats={vad}
            field="speechToPauseRatio"
            format={(v) => v.toFixed(2)}
          />
          <VadFieldRow
            label="SNR"
            vadStats={vad}
            field="snrDb"
            format={(v) => `${v.toFixed(1)} dB`}
          />
        </Stack>
      )}

      <Divider sx={{ my: 2 }} />

      <StandaloneMeterLink />
    </Paper>
  );
};

/**
 * Audio health section for the session detail page.
 *
 * A `Session` here is a *scheduled* record from schedule-management, not a live
 * one — this page is reachable for a class that ended last term and for one
 * starting next Tuesday. Live pipeline telemetry only exists inside the
 * session's effective window, so outside it the absence of an audio snapshot is
 * expected rather than a finding: warning an operator to go check a microphone
 * would be a false alarm on the majority of detail-page views. Outside the
 * window this also avoids subscribing to fleet telemetry at all (the live
 * component holds an SSE connection and re-reads `/fleet` on the poll interval).
 */
const AudioHealthSection = ({ session }: { session: Session }) => {
  const [now, setNow] = useState(() => Date.now());

  // Re-render every few seconds so the age, the staleness warning, and the
  // window classification stay current — a session that starts while the page
  // is open transitions to the live view on its own.
  useEffect(() => {
    const id = window.setInterval(() => {
      setNow(Date.now());
    }, 5_000);
    return () => {
      window.clearInterval(id);
    };
  }, []);

  const windowState = sessionWindowState(session, now);

  if (windowState !== 'within') {
    return (
      <AudioHealthPaper>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          {windowState === 'before'
            ? 'This session has not started yet, so there is no live audio telemetry for it. Levels appear here once it is on the air.'
            : 'This session has ended. Audio telemetry is point-in-time only — no history is retained — so there is nothing to show for a finished session.'}
        </Typography>
        <StandaloneMeterLink />
      </AudioHealthPaper>
    );
  }

  return <LiveAudioHealth sessionUid={session.uid} now={now} />;
};

export const SessionDetailPage = () => {
  const { sessionUid } = useParams<{ sessionUid: string }>();
  const { showSuccess, showError } = useToast();

  const {
    data: session,
    loading,
    error,
    reload,
  } = useAsyncData<Session>(
    () =>
      sessionUid === undefined
        ? Promise.reject(new ApiError('NOT_FOUND', 'No session id.', 404))
        : adminApi.getSession(sessionUid),
    [sessionUid],
  );

  // Branches derived from the load error rather than stored as separate state.
  const misconfigured = isApiErrorCode(error, 'BACKEND_MISCONFIGURATION');
  const notFound = error instanceof ApiError && error.status === 404;

  // A session's times belong to its room's timezone, but the session payload
  // carries only a roomUid — so the room is fetched for its zone alone. A
  // failure falls back to the browser's zone, which the note then declares,
  // rather than blanking the page.
  const { data: room } = useAsyncData<Room | null>(
    () =>
      session === null
        ? Promise.resolve(null)
        : adminApi.getRoom(session.roomUid),
    [session?.roomUid],
  );
  const timezone = room?.timezone;

  // Loaded independently of `session`: a failure here (or the session having
  // no join code yet) must not block the rest of the page, which already
  // renders fine from the primary load above.
  const { data: joinCodeStatus, reload: reloadJoinCode } =
    useAsyncData<SessionJoinCodeStatus>(
      () =>
        sessionUid === undefined
          ? Promise.reject(new ApiError('NOT_FOUND', 'No session id.', 404))
          : adminApi.getSessionJoinCode(sessionUid),
      [sessionUid],
    );

  useEffect(() => {
    const id = window.setInterval(reloadJoinCode, JOIN_CODE_POLL_MS);
    return () => {
      window.clearInterval(id);
    };
  }, [reloadJoinCode]);

  // `SessionJoinCodeStatus` isn't a true discriminated union (`joinCode`'s
  // nullability isn't tied to `status` in the type), so narrow explicitly
  // rather than asserting non-null in the JSX below.
  const joinCode =
    joinCodeStatus !== null &&
    joinCodeStatus.status === 'ok' &&
    joinCodeStatus.joinCode !== null
      ? joinCodeStatus.joinCode
      : null;
  const sessionJoinUrl = joinCode !== null ? buildJoinUrl(joinCode) : null;

  const [startConfirmOpen, setStartConfirmOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const [endConfirmOpen, setEndConfirmOpen] = useState(false);
  const [ending, setEnding] = useState(false);
  const [cancelConfirmOpen, setCancelConfirmOpen] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  // Any load failure that isn't misconfiguration or not-found is surfaced as a
  // toast, once per error.
  useEffect(() => {
    if (
      error !== null &&
      !isApiErrorCode(error, 'BACKEND_MISCONFIGURATION') &&
      !(error instanceof ApiError && error.status === 404)
    ) {
      showError(errorMessage(error, 'Failed to load session.'));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps, @eslint-react/exhaustive-deps
  }, [error]);

  const handleStartEarly = () => {
    if (sessionUid === undefined) return;
    setStarting(true);
    adminApi
      .startSessionEarly(sessionUid)
      .then(() => {
        showSuccess('Session started early.');
        reload();
      })
      .catch((err: unknown) => {
        showError(errorMessage(err, 'Failed to start session early.'));
      })
      .finally(() => {
        setStarting(false);
        setStartConfirmOpen(false);
      });
  };

  const handleEndEarly = () => {
    if (sessionUid === undefined) return;
    setEnding(true);
    adminApi
      .endSessionEarly(sessionUid)
      .then(() => {
        showSuccess('Session ended early.');
        reload();
      })
      .catch((err: unknown) => {
        showError(errorMessage(err, 'Failed to end session early.'));
      })
      .finally(() => {
        setEnding(false);
        setEndConfirmOpen(false);
      });
  };

  const handleCancel = () => {
    if (sessionUid === undefined) return;
    setCancelling(true);
    adminApi
      .cancelSession(sessionUid)
      .then(() => {
        showSuccess('Session canceled.', {
          label: 'Undo',
          onClick: () => {
            adminApi
              .uncancelSession(sessionUid)
              .then(() => {
                showSuccess('Cancellation undone.');
                reload();
              })
              .catch((err: unknown) => {
                if (isApiErrorCode(err, 'SLOT_NO_LONGER_AVAILABLE')) {
                  showError(
                    "Can't undo — another session now occupies this time.",
                  );
                } else {
                  showError(errorMessage(err, 'Failed to undo cancellation.'));
                }
              });
          },
        });
        reload();
      })
      .catch((err: unknown) => {
        showError(errorMessage(err, 'Failed to cancel session.'));
      })
      .finally(() => {
        setCancelling(false);
        setCancelConfirmOpen(false);
      });
  };

  if (loading && session === null) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
        <CircularProgress />
      </Box>
    );
  }

  if (misconfigured && session === null) {
    return (
      <Alert severity="error">
        Admin backend misconfiguration — an operator must check the
        server&apos;s ADMIN_API_KEY.
      </Alert>
    );
  }

  if (notFound || session === null) {
    return <Alert severity="warning">Session not found.</Alert>;
  }

  return (
    <Box>
      {misconfigured && (
        <Alert severity="error" sx={{ mb: 2 }}>
          Admin backend misconfiguration — an operator must check the
          server&apos;s ADMIN_API_KEY.
        </Alert>
      )}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2 }}>
        <Typography variant="h5" component="h1">
          {session.name}
        </Typography>
        <Chip
          size="small"
          label={session.type}
          color="primary"
          variant="outlined"
        />
        {session.canceledAt !== null && (
          <Chip size="small" label="Canceled" color="default" />
        )}
        <Link
          component={RouterLink}
          to={`/rooms/${session.roomUid}/calendar?date=${dateOnly(session.effectiveStart)}`}
          sx={{ ml: 'auto' }}
        >
          View in calendar
        </Link>
      </Box>
      <TimezoneNote timezone={timezone} />
      <Paper variant="outlined" sx={{ p: 3, mb: 3 }}>
        <Stack spacing={2}>
          <FieldRow label="Room">
            <Link component={RouterLink} to={`/rooms/${session.roomUid}`}>
              {session.roomUid}
            </Link>
          </FieldRow>
          <Divider />
          <FieldRow label="Scheduled start">
            <Typography>
              {formatDateTime(session.scheduledStartTime, timezone)}
            </Typography>
          </FieldRow>
          <Divider />
          <FieldRow label="Scheduled end">
            <Typography>
              {formatDateTime(session.scheduledEndTime, timezone)}
            </Typography>
          </FieldRow>
          <Divider />
          <FieldRow label="Effective start">
            <Typography>
              {formatDateTime(session.effectiveStart, timezone)}
            </Typography>
          </FieldRow>
          <Divider />
          <FieldRow label="Effective end">
            <Typography>
              {formatDateTime(session.effectiveEnd, timezone)}
            </Typography>
          </FieldRow>
          {session.canceledAt !== null && (
            <>
              <Divider />
              <FieldRow label="Canceled at">
                <Typography>
                  {formatDateTime(session.canceledAt, timezone)}
                </Typography>
              </FieldRow>
            </>
          )}
          <Divider />
          <FieldRow label="Join code scopes">
            <Stack direction="row" spacing={1}>
              {session.joinCodeScopes.map((scope) => (
                <Chip key={scope} size="small" label={scope} />
              ))}
            </Stack>
          </FieldRow>
          <Divider />
          <FieldRow label="Transcription provider">
            <Typography>{session.transcriptionProviderId}</Typography>
          </FieldRow>
          <Divider />
          <FieldRow label="Created">
            <Typography>
              {formatDateTime(session.createdAt, timezone)}
            </Typography>
          </FieldRow>
        </Stack>
      </Paper>
      <Paper variant="outlined" sx={{ p: 3, mb: 3 }}>
        <Typography variant="h6" component="h2" sx={{ mb: 2 }}>
          Join session
        </Typography>
        {joinCodeStatus === null ? (
          <Typography
            variant="body2"
            sx={{
              color: 'text.secondary',
            }}
          >
            Join code unavailable.
          </Typography>
        ) : joinCodeStatus.status === 'no-join-scopes' ? (
          <Typography
            variant="body2"
            sx={{
              color: 'text.secondary',
            }}
          >
            No join code scopes configured for this session.
          </Typography>
        ) : joinCodeStatus.status === 'not-active' ||
          joinCode === null ||
          sessionJoinUrl === null ? (
          <Typography
            variant="body2"
            sx={{
              color: 'text.secondary',
            }}
          >
            Session is not currently active — no join code available.
          </Typography>
        ) : (
          <Stack spacing={1.5}>
            <Stack
              direction="row"
              spacing={0.5}
              sx={{
                alignItems: 'center',
              }}
            >
              <Button
                variant="contained"
                startIcon={<OpenInNewIcon />}
                component="a"
                href={sessionJoinUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                Open live captions
              </Button>
              <CopyIconButton value={sessionJoinUrl} label="join link" />
            </Stack>
            <Stack
              direction="row"
              spacing={0.5}
              sx={{
                alignItems: 'center',
              }}
            >
              <Typography
                variant="body2"
                sx={{
                  color: 'text.secondary',
                }}
              >
                Join code <strong>{joinCode}</strong> · rotates every few
                minutes
              </Typography>
              <CopyIconButton value={joinCode} label="join code" />
            </Stack>
          </Stack>
        )}
      </Paper>

      <AudioHealthSection session={session} />

      <Stack direction="row" spacing={2}>
        {canStartEarly(session, new Date()) && (
          <Button
            variant="outlined"
            onClick={() => {
              setStartConfirmOpen(true);
            }}
          >
            Start early
          </Button>
        )}
        {canEndEarly(session, new Date()) && (
          <Button
            variant="outlined"
            color="error"
            onClick={() => {
              setEndConfirmOpen(true);
            }}
          >
            End early
          </Button>
        )}
        {canCancel(session, new Date()) && (
          <Button
            variant="outlined"
            color="error"
            onClick={() => {
              setCancelConfirmOpen(true);
            }}
          >
            Cancel session
          </Button>
        )}
      </Stack>
      <ConfirmDialog
        open={startConfirmOpen}
        title="Start session early"
        message="This starts the session now, ahead of its scheduled start time."
        confirmLabel="Start early"
        loading={starting}
        onConfirm={handleStartEarly}
        onClose={() => {
          setStartConfirmOpen(false);
        }}
      />
      <ConfirmDialog
        open={cancelConfirmOpen}
        title="Cancel session"
        message="This cancels this one occurrence. It does not affect the recurring schedule or any other occurrence. If a matching auto-session window covers this time, an auto-generated session may fill the gap. Editing or deleting the parent schedule later will also remove this cancellation."
        confirmLabel="Cancel session"
        confirmColor="error"
        loading={cancelling}
        onConfirm={handleCancel}
        onClose={() => {
          setCancelConfirmOpen(false);
        }}
      />

      <ConfirmDialog
        open={endConfirmOpen}
        title="End session early"
        message="This ends the session now, ahead of its scheduled end time."
        confirmLabel="End early"
        confirmColor="error"
        loading={ending}
        onConfirm={handleEndEarly}
        onClose={() => {
          setEndConfirmOpen(false);
        }}
      />
    </Box>
  );
};
