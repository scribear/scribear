import { type SyntheticEvent, useEffect, useState } from 'react';

import AddIcon from '@mui/icons-material/Add';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
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
  SessionSchedule,
} from '@scribear/session-manager-schema';

import { ConfirmDialog } from '#src/components/confirm-dialog';
import { adminApi } from '#src/lib/admin-api';
import { isApiErrorCode } from '#src/lib/api-error';
import { useToast } from '#src/lib/toast-context';

import { AutoWindowDialog } from './auto-window-dialog';
import { OnDemandDialog } from './on-demand-dialog';
import { ScheduleDialog } from './schedule-dialog';
import { errorMessage, formatInRoomTz } from './scheduling-form-helpers';

const RANGE_DAYS = 90;

export const RoomSchedulingPage = () => {
  const { roomUid } = useParams<{ roomUid: string }>();
  const navigate = useNavigate();
  const { showSuccess, showError } = useToast();

  const [room, setRoom] = useState<Room | null>(null);
  const [loading, setLoading] = useState(true);
  const [misconfigured, setMisconfigured] = useState(false);
  const [autoToggling, setAutoToggling] = useState(false);

  const [schedules, setSchedules] = useState<SessionSchedule[]>([]);
  const [schedulesLoading, setSchedulesLoading] = useState(true);
  const [scheduleDialogOpen, setScheduleDialogOpen] = useState(false);
  const [editingSchedule, setEditingSchedule] =
    useState<SessionSchedule | null>(null);
  const [deleteScheduleUid, setDeleteScheduleUid] = useState<string | null>(
    null,
  );
  const [deletingSchedule, setDeletingSchedule] = useState(false);

  const [windows, setWindows] = useState<AutoSessionWindow[]>([]);
  const [windowsLoading, setWindowsLoading] = useState(true);
  const [windowDialogOpen, setWindowDialogOpen] = useState(false);
  const [editingWindow, setEditingWindow] = useState<AutoSessionWindow | null>(
    null,
  );
  const [deleteWindowUid, setDeleteWindowUid] = useState<string | null>(null);
  const [deletingWindow, setDeletingWindow] = useState(false);

  const [onDemandOpen, setOnDemandOpen] = useState(false);

  const rangeFrom = new Date().toISOString();
  const rangeTo = new Date(
    Date.now() + RANGE_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();

  const loadSchedules = () => {
    if (roomUid === undefined) return;
    setSchedulesLoading(true);
    adminApi
      .listSchedules({ roomUid, from: rangeFrom, to: rangeTo })
      .then((res) => {
        setSchedules(res.items);
      })
      .catch((err: unknown) => {
        if (!isApiErrorCode(err, 'BACKEND_MISCONFIGURATION')) {
          showError(errorMessage(err, 'Failed to load schedules.'));
        }
      })
      .finally(() => {
        setSchedulesLoading(false);
      });
  };

  const loadWindows = () => {
    if (roomUid === undefined) return;
    setWindowsLoading(true);
    adminApi
      .listAutoWindows({ roomUid, from: rangeFrom, to: rangeTo })
      .then((res) => {
        setWindows(res.items);
      })
      .catch((err: unknown) => {
        if (!isApiErrorCode(err, 'BACKEND_MISCONFIGURATION')) {
          showError(errorMessage(err, 'Failed to load auto-session windows.'));
        }
      })
      .finally(() => {
        setWindowsLoading(false);
      });
  };

  useEffect(() => {
    const alive = { current: true };
    if (roomUid === undefined) return;
    setLoading(true);
    setSchedulesLoading(true);
    setWindowsLoading(true);
    adminApi
      .roomDetail(roomUid)
      .then((res) => {
        if (!alive.current) return;
        setMisconfigured(false);
        setRoom(res.room);
      })
      .catch((err: unknown) => {
        if (!alive.current) return;
        if (isApiErrorCode(err, 'BACKEND_MISCONFIGURATION')) {
          setMisconfigured(true);
        } else {
          showError(errorMessage(err, 'Failed to load room.'));
        }
      })
      .finally(() => {
        if (alive.current) setLoading(false);
      });
    adminApi
      .listSchedules({ roomUid, from: rangeFrom, to: rangeTo })
      .then((res) => {
        if (alive.current) setSchedules(res.items);
      })
      .catch((err: unknown) => {
        if (!alive.current) return;
        if (!isApiErrorCode(err, 'BACKEND_MISCONFIGURATION')) {
          showError(errorMessage(err, 'Failed to load schedules.'));
        }
      })
      .finally(() => {
        if (alive.current) setSchedulesLoading(false);
      });
    adminApi
      .listAutoWindows({ roomUid, from: rangeFrom, to: rangeTo })
      .then((res) => {
        if (alive.current) setWindows(res.items);
      })
      .catch((err: unknown) => {
        if (!alive.current) return;
        if (!isApiErrorCode(err, 'BACKEND_MISCONFIGURATION')) {
          showError(errorMessage(err, 'Failed to load auto-session windows.'));
        }
      })
      .finally(() => {
        if (alive.current) setWindowsLoading(false);
      });
    return () => {
      alive.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomUid]);

  const handleToggleAuto = (_e: SyntheticEvent, checked: boolean) => {
    if (roomUid === undefined || room === null) return;
    setAutoToggling(true);
    adminApi
      .updateRoomScheduleConfig({ roomUid, autoSessionEnabled: checked })
      .then((updated) => {
        setRoom(updated);
        showSuccess(
          checked ? 'Auto-sessions enabled.' : 'Auto-sessions disabled.',
        );
      })
      .catch((err: unknown) => {
        if (isApiErrorCode(err, 'BACKEND_MISCONFIGURATION')) {
          setMisconfigured(true);
        } else {
          showError(
            errorMessage(err, 'Failed to update auto-session setting.'),
          );
        }
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
        loadSchedules();
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
        loadWindows();
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
        <CircularProgress />
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
      <Typography color="text.secondary">Room not found.</Typography>
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
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        All times below are shown in this room&apos;s timezone ({room.timezone}
        ).
      </Typography>

      <Card sx={{ mb: 3 }}>
        <CardContent>
          <Grid container spacing={2} alignItems="center">
            <Grid size={{ xs: 12, sm: 8 }}>
              <Typography variant="body1">Auto-sessions</Typography>
              <Typography variant="body2" color="text.secondary">
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
          <Typography variant="body2" color="text.secondary">
            Showing occurrences between{' '}
            {formatInRoomTz(rangeFrom, room.timezone)} and{' '}
            {formatInRoomTz(rangeTo, room.timezone)} (next {RANGE_DAYS} days).
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
                  <CircularProgress size={28} />
                </TableCell>
              </TableRow>
            ) : schedules.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} align="center" sx={{ py: 4 }}>
                  <Typography color="text.secondary">
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
                    {formatInRoomTz(s.activeStart, room.timezone)}
                  </TableCell>
                  <TableCell>
                    {s.activeEnd === null
                      ? 'Indefinite'
                      : formatInRoomTz(s.activeEnd, room.timezone)}
                  </TableCell>
                  <TableCell align="right">
                    <Stack
                      direction="row"
                      spacing={1}
                      justifyContent="flex-end"
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
          <Typography variant="body2" color="text.secondary">
            Showing occurrences between{' '}
            {formatInRoomTz(rangeFrom, room.timezone)} and{' '}
            {formatInRoomTz(rangeTo, room.timezone)} (next {RANGE_DAYS} days).
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
                  <CircularProgress size={28} />
                </TableCell>
              </TableRow>
            ) : windows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} align="center" sx={{ py: 4 }}>
                  <Typography color="text.secondary">
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
                    {formatInRoomTz(w.activeStart, room.timezone)}
                  </TableCell>
                  <TableCell>
                    {w.activeEnd === null
                      ? 'Indefinite'
                      : formatInRoomTz(w.activeEnd, room.timezone)}
                  </TableCell>
                  <TableCell align="right">
                    <Stack
                      direction="row"
                      spacing={1}
                      justifyContent="flex-end"
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
            loadSchedules();
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
            loadWindows();
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
