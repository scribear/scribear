import {
  type SyntheticEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import AddIcon from '@mui/icons-material/Add';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import FormControlLabel from '@mui/material/FormControlLabel';
import Grid from '@mui/material/Grid';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Typography from '@mui/material/Typography';

import { useNavigate, useParams } from 'react-router-dom';

import type {
  AutoSessionWindow,
  Room,
  Session,
  SessionSchedule,
} from '@scribear/session-manager-schema';

import { ConfirmDialog } from '#src/components/confirm-dialog';
import { TimezoneNote } from '#src/components/timezone-note';
import { adminApi } from '#src/lib/admin-api';
import { ApiError, isApiErrorCode } from '#src/lib/api-error';
import { formatInTimeZone } from '#src/lib/timezone';
import { useToast } from '#src/lib/toast-context';
import { useAsyncData } from '#src/lib/use-async-data';

import { AutoWindowDialog } from './auto-window-dialog';
import { OnDemandDialog } from './on-demand-dialog';
import { ScheduleDialog } from './schedule-dialog';

const RANGE_DAYS = 90;
// How far back the scheduling page looks. The session listing uses an overlap
// predicate, so a session that started before page-load (e.g. an active
// on-demand session) still appears. The schedule/window listing filters on
// `active_start <= to`, so this primarily governs sessions.
const LOOKBACK_DAYS = 7;
// The scheduling page has no server-push; poll the session list so a session
// created or started elsewhere (e.g. by the auto-session reconciler, or by
// another operator) appears without a manual reload. Gated on tab visibility
// in the effect below.
const SESSION_POLL_MS = 15_000;

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

export const RoomSchedulingPage = () => {
  const { roomUid } = useParams<{ roomUid: string }>();
  const navigate = useNavigate();
  const { showSuccess, showError } = useToast();

  const [autoToggling, setAutoToggling] = useState(false);

  const [scheduleDialogOpen, setScheduleDialogOpen] = useState(false);
  const [editingSchedule, setEditingSchedule] =
    useState<SessionSchedule | null>(null);
  const [deleteScheduleUid, setDeleteScheduleUid] = useState<string | null>(
    null,
  );
  const [deletingSchedule, setDeletingSchedule] = useState(false);

  const [windowDialogOpen, setWindowDialogOpen] = useState(false);
  const [editingWindow, setEditingWindow] = useState<AutoSessionWindow | null>(
    null,
  );
  const [deleteWindowUid, setDeleteWindowUid] = useState<string | null>(null);
  const [deletingWindow, setDeletingWindow] = useState(false);

  const [onDemandOpen, setOnDemandOpen] = useState(false);

  // Fixed once per mount: computing "now" directly during render would make
  // the range drift on every re-render (impure render, flagged by
  // react-hooks/purity and @eslint-react/purity).
  const [rangeFrom, rangeTo] = useMemo(() => {
    const to = new Date();
    const from = new Date(to.getTime() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
    const forward = new Date(to.getTime() + RANGE_DAYS * 24 * 60 * 60 * 1000);
    return [from.toISOString(), forward.toISOString()];
  }, []);

  // "now" for the active-session classification in the sessions table. Updated
  // on the same cadence as the session poll below so the "active" chip stays
  // current without an impure `Date.now()` during render.
  const [now, setNow] = useState(() => Date.now());

  const {
    data: room,
    loading,
    error: roomError,
    reload: reloadRoom,
  } = useAsyncData<Room>(
    () =>
      roomUid === undefined
        ? Promise.reject(new ApiError('NOT_FOUND', 'No room id.', 404))
        : adminApi.roomDetail(roomUid).then((res) => res.room),
    [roomUid],
  );

  const {
    data: schedulesData,
    loading: schedulesLoading,
    error: schedulesError,
    reload: reloadSchedules,
  } = useAsyncData<SessionSchedule[]>(
    () =>
      roomUid === undefined
        ? Promise.resolve([])
        : adminApi
            .listSchedules({ roomUid, from: rangeFrom, to: rangeTo })
            .then((res) => res.items),
    [roomUid],
  );
  const schedules = schedulesData ?? [];

  const {
    data: windowsData,
    loading: windowsLoading,
    error: windowsError,
    reload: reloadWindows,
  } = useAsyncData<AutoSessionWindow[]>(
    () =>
      roomUid === undefined
        ? Promise.resolve([])
        : adminApi
            .listAutoWindows({ roomUid, from: rangeFrom, to: rangeTo })
            .then((res) => res.items),
    [roomUid],
  );
  const windows = windowsData ?? [];

  // Live session rows (SCHEDULED/ON_DEMAND/AUTO) overlapping the range. Unlike
  // schedules and windows, these include on-demand and AUTO sessions, which
  // have no parent schedule and were previously invisible on this page.
  const {
    data: sessionsData,
    loading: sessionsLoading,
    error: sessionsError,
    reload: reloadSessions,
  } = useAsyncData<Session[]>(
    () =>
      roomUid === undefined
        ? Promise.resolve([])
        : adminApi
            .listSessions({ roomUids: [roomUid], from: rangeFrom, to: rangeTo })
            .then((res) => res.items),
    [roomUid],
  );
  const sessions = sessionsData ?? [];
  // `useAsyncData` raises `loading` on every re-fetch, including the 15s poll
  // below. Gating the table body on it directly would blank the rows to a
  // spinner once per poll forever; only the first load has nothing to show.
  // Same idiom as the page-level `loading && room === null` guard.
  const sessionsInitialLoading = sessionsLoading && sessionsData === null;

  // Poll the session list so a session created or started elsewhere (by the
  // auto-session reconciler, or by another operator) appears without a manual
  // reload. Paused when the tab is hidden to avoid hammering a backgrounded
  // page. The schedule/window lists are slower-moving and reload on mutation.
  useEffect(() => {
    const poll = () => {
      if (document.visibilityState === 'visible') {
        reloadSessions();
        setNow(Date.now());
      }
    };
    const id = window.setInterval(poll, SESSION_POLL_MS);
    document.addEventListener('visibilitychange', poll);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', poll);
    };
  }, [reloadSessions]);

  // Banner is derived from the room load; a misconfiguration raised by the
  // auto-session toggle surfaces as a toast instead (see handleToggleAuto).
  const misconfigured = isApiErrorCode(roomError, 'BACKEND_MISCONFIGURATION');

  // Each load's non-misconfiguration failure is surfaced as a toast, once per
  // error (schedule/window misconfigurations stay silent, as before).
  useEffect(() => {
    if (
      roomError !== null &&
      !isApiErrorCode(roomError, 'BACKEND_MISCONFIGURATION')
    ) {
      showError(errorMessage(roomError, 'Failed to load room.'));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps, @eslint-react/exhaustive-deps
  }, [roomError]);
  useEffect(() => {
    if (
      schedulesError !== null &&
      !isApiErrorCode(schedulesError, 'BACKEND_MISCONFIGURATION')
    ) {
      showError(errorMessage(schedulesError, 'Failed to load schedules.'));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps, @eslint-react/exhaustive-deps
  }, [schedulesError]);
  useEffect(() => {
    if (
      windowsError !== null &&
      !isApiErrorCode(windowsError, 'BACKEND_MISCONFIGURATION')
    ) {
      showError(
        errorMessage(windowsError, 'Failed to load auto-session windows.'),
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps, @eslint-react/exhaustive-deps
  }, [windowsError]);
  // Unlike the schedule/window loads, this one repeats every SESSION_POLL_MS,
  // so a backend that stays down would raise a fresh error object — and a
  // fresh toast — four times a minute for as long as the page is open. Toast
  // only when the failure is new, and reset once a poll succeeds so a later
  // outage is still reported.
  const lastSessionsErrorRef = useRef<string | null>(null);
  useEffect(() => {
    if (sessionsError === null) {
      lastSessionsErrorRef.current = null;
      return;
    }
    if (isApiErrorCode(sessionsError, 'BACKEND_MISCONFIGURATION')) return;
    const message = errorMessage(sessionsError, 'Failed to load sessions.');
    if (lastSessionsErrorRef.current === message) return;
    lastSessionsErrorRef.current = message;
    showError(message);
    // eslint-disable-next-line react-hooks/exhaustive-deps, @eslint-react/exhaustive-deps
  }, [sessionsError]);

  const handleToggleAuto = (_e: SyntheticEvent, checked: boolean) => {
    if (roomUid === undefined || room === null) return;
    setAutoToggling(true);
    adminApi
      .updateRoomScheduleConfig({ roomUid, autoSessionEnabled: checked })
      .then(() => {
        reloadRoom();
        showSuccess(
          checked ? 'Auto-sessions enabled.' : 'Auto-sessions disabled.',
        );
      })
      .catch((err: unknown) => {
        showError(errorMessage(err, 'Failed to update auto-session setting.'));
      })
      .finally(() => {
        setAutoToggling(false);
      });
  };

  const handleDeleteSchedule = () => {
    if (deleteScheduleUid === null) return;
    setDeletingSchedule(true);
    adminApi
      .deleteSchedule(deleteScheduleUid)
      .then(() => {
        showSuccess('Schedule deleted.');
        reloadSchedules();
      })
      .catch((err: unknown) => {
        showError(errorMessage(err, 'Failed to delete schedule.'));
      })
      .finally(() => {
        setDeletingSchedule(false);
        setDeleteScheduleUid(null);
      });
  };

  const handleDeleteWindow = () => {
    if (deleteWindowUid === null) return;
    setDeletingWindow(true);
    adminApi
      .deleteAutoWindow(deleteWindowUid)
      .then(() => {
        showSuccess('Auto-session window deleted.');
        reloadWindows();
      })
      .catch((err: unknown) => {
        showError(errorMessage(err, 'Failed to delete window.'));
      })
      .finally(() => {
        setDeletingWindow(false);
        setDeleteWindowUid(null);
      });
  };

  if (loading && room === null) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
        <CircularProgress aria-label="Loading room" />
      </Box>
    );
  }

  if (room === null) {
    return misconfigured ? (
      <Alert severity="error">
        Admin backend misconfiguration — an operator must check the
        server&apos;s ADMIN_API_KEY.
      </Alert>
    ) : (
      <Typography
        sx={{
          color: 'text.secondary',
        }}
      >
        Room not found.
      </Typography>
    );
  }

  return (
    <Box>
      {misconfigured && (
        <Alert severity="error" sx={{ mb: 2 }}>
          Admin backend misconfiguration — an operator must check the
          server&apos;s ADMIN_API_KEY.
        </Alert>
      )}
      <Box
        sx={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 2,
        }}
      >
        <Typography variant="h5" component="h1" gutterBottom>
          Scheduling — {room.name}
        </Typography>
        <Button
          variant="outlined"
          onClick={() => {
            void navigate(`/rooms/${room.uid}/calendar`);
          }}
        >
          View calendar
        </Button>
      </Box>
      <TimezoneNote timezone={room.timezone} />
      <Card sx={{ mb: 3 }}>
        <CardContent>
          <Grid
            container
            spacing={2}
            sx={{
              alignItems: 'center',
            }}
          >
            <Grid size={{ xs: 12, sm: 8 }}>
              <Typography variant="body1">Auto-sessions</Typography>
              <Typography
                variant="body2"
                sx={{
                  color: 'text.secondary',
                }}
              >
                When enabled, auto-session windows produce AUTO sessions to fill
                any gaps left by scheduled/on-demand sessions.
              </Typography>
            </Grid>
            <Grid size={{ xs: 12, sm: 4 }} sx={{ textAlign: { sm: 'right' } }}>
              <FormControlLabel
                control={
                  <Switch
                    checked={room.autoSessionEnabled}
                    disabled={autoToggling}
                    onChange={handleToggleAuto}
                  />
                }
                label={room.autoSessionEnabled ? 'Enabled' : 'Disabled'}
              />
            </Grid>
          </Grid>
        </CardContent>
      </Card>
      <Box
        sx={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          mb: 1,
        }}
      >
        <Box>
          <Typography variant="h6" component="h2">
            Schedules
          </Typography>
          <Typography
            variant="body2"
            sx={{
              color: 'text.secondary',
            }}
          >
            Showing occurrences between{' '}
            {formatInTimeZone(rangeFrom, room.timezone)} and{' '}
            {formatInTimeZone(rangeTo, room.timezone)} (last {LOOKBACK_DAYS}{' '}
            days and next {RANGE_DAYS} days).
          </Typography>
        </Box>
        <Button
          variant="contained"
          startIcon={<AddIcon />}
          onClick={() => {
            setEditingSchedule(null);
            setScheduleDialogOpen(true);
          }}
        >
          New schedule
        </Button>
      </Box>
      <TableContainer component={Paper} sx={{ mb: 3 }}>
        <Table>
          <TableHead>
            <TableRow>
              <TableCell>Name</TableCell>
              <TableCell>Frequency</TableCell>
              <TableCell>Days</TableCell>
              <TableCell>Local time</TableCell>
              <TableCell>Active start</TableCell>
              <TableCell>Active end</TableCell>
              <TableCell align="right">Actions</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {schedulesLoading ? (
              <TableRow>
                <TableCell colSpan={7} align="center" sx={{ py: 4 }}>
                  <CircularProgress size={28} aria-label="Loading schedules" />
                </TableCell>
              </TableRow>
            ) : schedules.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} align="center" sx={{ py: 4 }}>
                  <Typography
                    sx={{
                      color: 'text.secondary',
                    }}
                  >
                    No schedules in this range.
                  </Typography>
                </TableCell>
              </TableRow>
            ) : (
              schedules.map((s) => (
                <TableRow key={s.uid}>
                  <TableCell>{s.name}</TableCell>
                  <TableCell>{s.frequency}</TableCell>
                  <TableCell>
                    {s.daysOfWeek ? s.daysOfWeek.join(', ') : '—'}
                  </TableCell>
                  <TableCell>
                    {s.localStartTime.slice(0, 5)}–{s.localEndTime.slice(0, 5)}
                  </TableCell>
                  <TableCell>
                    {formatInTimeZone(s.activeStart, room.timezone)}
                  </TableCell>
                  <TableCell>
                    {s.activeEnd === null
                      ? 'Indefinite'
                      : formatInTimeZone(s.activeEnd, room.timezone)}
                  </TableCell>
                  <TableCell align="right">
                    <Stack
                      direction="row"
                      spacing={1}
                      sx={{
                        justifyContent: 'flex-end',
                      }}
                    >
                      <Button
                        size="small"
                        onClick={() => {
                          setEditingSchedule(s);
                          setScheduleDialogOpen(true);
                        }}
                      >
                        Edit
                      </Button>
                      <Button
                        size="small"
                        color="error"
                        onClick={() => {
                          setDeleteScheduleUid(s.uid);
                        }}
                      >
                        Delete
                      </Button>
                    </Stack>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </TableContainer>
      <Box
        sx={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          mb: 1,
        }}
      >
        <Box>
          <Typography variant="h6" component="h2">
            Auto-session windows
          </Typography>
          <Typography
            variant="body2"
            sx={{
              color: 'text.secondary',
            }}
          >
            Showing occurrences between{' '}
            {formatInTimeZone(rangeFrom, room.timezone)} and{' '}
            {formatInTimeZone(rangeTo, room.timezone)} (last {LOOKBACK_DAYS}{' '}
            days and next {RANGE_DAYS} days).
          </Typography>
        </Box>
        <Button
          variant="contained"
          startIcon={<AddIcon />}
          onClick={() => {
            setEditingWindow(null);
            setWindowDialogOpen(true);
          }}
        >
          New window
        </Button>
      </Box>
      <TableContainer component={Paper} sx={{ mb: 3 }}>
        <Table>
          <TableHead>
            <TableRow>
              <TableCell>Days</TableCell>
              <TableCell>Local time</TableCell>
              <TableCell>Active start</TableCell>
              <TableCell>Active end</TableCell>
              <TableCell align="right">Actions</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {windowsLoading ? (
              <TableRow>
                <TableCell colSpan={5} align="center" sx={{ py: 4 }}>
                  <CircularProgress
                    size={28}
                    aria-label="Loading auto-session windows"
                  />
                </TableCell>
              </TableRow>
            ) : windows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} align="center" sx={{ py: 4 }}>
                  <Typography
                    sx={{
                      color: 'text.secondary',
                    }}
                  >
                    No auto-session windows in this range.
                  </Typography>
                </TableCell>
              </TableRow>
            ) : (
              windows.map((w) => (
                <TableRow key={w.uid}>
                  <TableCell>{w.daysOfWeek.join(', ')}</TableCell>
                  <TableCell>
                    {w.localStartTime.slice(0, 5)}–{w.localEndTime.slice(0, 5)}
                  </TableCell>
                  <TableCell>
                    {formatInTimeZone(w.activeStart, room.timezone)}
                  </TableCell>
                  <TableCell>
                    {w.activeEnd === null
                      ? 'Indefinite'
                      : formatInTimeZone(w.activeEnd, room.timezone)}
                  </TableCell>
                  <TableCell align="right">
                    <Stack
                      direction="row"
                      spacing={1}
                      sx={{
                        justifyContent: 'flex-end',
                      }}
                    >
                      <Button
                        size="small"
                        onClick={() => {
                          setEditingWindow(w);
                          setWindowDialogOpen(true);
                        }}
                      >
                        Edit
                      </Button>
                      <Button
                        size="small"
                        color="error"
                        onClick={() => {
                          setDeleteWindowUid(w.uid);
                        }}
                      >
                        Delete
                      </Button>
                    </Stack>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </TableContainer>
      <Box
        sx={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          mb: 1,
        }}
      >
        <Box>
          <Typography variant="h6" component="h2">
            Sessions
          </Typography>
          <Typography
            variant="body2"
            sx={{
              color: 'text.secondary',
            }}
          >
            Live session rows (scheduled, on-demand, and auto) overlapping the
            last {LOOKBACK_DAYS} days and next {RANGE_DAYS} days.
          </Typography>
        </Box>
      </Box>
      <TableContainer component={Paper} sx={{ mb: 3 }}>
        <Table>
          <TableHead>
            <TableRow>
              <TableCell>Name</TableCell>
              <TableCell>Type</TableCell>
              <TableCell>Effective start</TableCell>
              <TableCell>Effective end</TableCell>
              <TableCell align="right">Actions</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {sessionsInitialLoading ? (
              <TableRow>
                <TableCell colSpan={5} align="center" sx={{ py: 4 }}>
                  <CircularProgress size={28} aria-label="Loading sessions" />
                </TableCell>
              </TableRow>
            ) : sessions.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} align="center" sx={{ py: 4 }}>
                  <Typography
                    sx={{
                      color: 'text.secondary',
                    }}
                  >
                    No sessions in this range.
                  </Typography>
                </TableCell>
              </TableRow>
            ) : (
              sessions.map((s) => {
                const isActive =
                  new Date(s.effectiveStart).getTime() <= now &&
                  (s.effectiveEnd === null ||
                    new Date(s.effectiveEnd).getTime() > now);
                return (
                  <TableRow key={s.uid}>
                    <TableCell>{s.name}</TableCell>
                    <TableCell>
                      <Stack
                        direction="row"
                        spacing={1}
                        sx={{ alignItems: 'center' }}
                      >
                        <Chip size="small" label={s.type} variant="outlined" />
                        {isActive && (
                          <Chip size="small" label="active" color="success" />
                        )}
                      </Stack>
                    </TableCell>
                    <TableCell>
                      {formatInTimeZone(s.effectiveStart, room.timezone)}
                    </TableCell>
                    <TableCell>
                      {s.effectiveEnd === null
                        ? 'Open-ended'
                        : formatInTimeZone(s.effectiveEnd, room.timezone)}
                    </TableCell>
                    <TableCell align="right">
                      <Button
                        size="small"
                        onClick={() => {
                          void navigate(`/sessions/${s.uid}`);
                        }}
                      >
                        View
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </TableContainer>
      <Box sx={{ mb: 3 }}>
        <Typography variant="h6" component="h2" gutterBottom>
          On-demand session
        </Typography>
        <Button
          variant="outlined"
          onClick={() => {
            setOnDemandOpen(true);
          }}
        >
          Start a session now
        </Button>
      </Box>
      {scheduleDialogOpen && (
        <ScheduleDialog
          roomUid={room.uid}
          schedule={editingSchedule}
          onClose={() => {
            setScheduleDialogOpen(false);
          }}
          onSaved={() => {
            setScheduleDialogOpen(false);
            reloadSchedules();
          }}
        />
      )}
      {windowDialogOpen && (
        <AutoWindowDialog
          roomUid={room.uid}
          window={editingWindow}
          onClose={() => {
            setWindowDialogOpen(false);
          }}
          onSaved={() => {
            setWindowDialogOpen(false);
            reloadWindows();
          }}
        />
      )}
      {onDemandOpen && (
        <OnDemandDialog
          roomUid={room.uid}
          onClose={() => {
            setOnDemandOpen(false);
          }}
          onCreated={(sessionUid) => {
            setOnDemandOpen(false);
            reloadSessions();
            void navigate(`/sessions/${sessionUid}`);
          }}
        />
      )}
      <ConfirmDialog
        open={deleteScheduleUid !== null}
        title="Delete schedule"
        message="This deletes the schedule and its future occurrences."
        confirmLabel="Delete"
        confirmColor="error"
        loading={deletingSchedule}
        onConfirm={handleDeleteSchedule}
        onClose={() => {
          setDeleteScheduleUid(null);
        }}
      />
      <ConfirmDialog
        open={deleteWindowUid !== null}
        title="Delete auto-session window"
        message="This deletes the auto-session window and stops it from producing further AUTO sessions."
        confirmLabel="Delete"
        confirmColor="error"
        loading={deletingWindow}
        onConfirm={handleDeleteWindow}
        onClose={() => {
          setDeleteWindowUid(null);
        }}
      />
    </Box>
  );
};
