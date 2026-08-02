import { useEffect, useState } from 'react';

import AddIcon from '@mui/icons-material/Add';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import ButtonGroup from '@mui/material/ButtonGroup';
import CircularProgress from '@mui/material/CircularProgress';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

import {
  Link as RouterLink,
  useNavigate,
  useParams,
  useSearchParams,
} from 'react-router-dom';

import type { Room, Session } from '@scribear/session-manager-schema';

import { NameWithUid } from '#src/components/name-with-uid';
import { adminApi } from '#src/lib/admin-api';
import { ApiError, isApiErrorCode } from '#src/lib/api-error';
import { hourRangeAt, nextHourRangeIndex } from '#src/lib/session-rules';
import { useSettings } from '#src/lib/settings-context';
import { useToast } from '#src/lib/toast-context';
import { useAsyncData } from '#src/lib/use-async-data';

import { AutoWindowDialog } from '../scheduling/auto-window-dialog';
import { OnDemandDialog } from '../scheduling/on-demand-dialog';
import { ScheduleDialog } from '../scheduling/schedule-dialog';
import { errorMessage } from '../scheduling/scheduling-form-helpers';
import {
  type CalendarColumn,
  SessionCalendarGrid,
} from './session-calendar-grid';
import { isOutsideHourWindow } from './session-calendar-grid.utils';

type ViewMode = 'week' | 'day';

const MATERIALIZATION_HORIZON_DAYS = 7;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** YYYY-MM-DD in the browser's local time zone (not UTC). */
function localDateKey(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const year = String(d.getFullYear());
  return `${year}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function startOfLocalDay(d: Date): Date {
  const copy = new Date(d);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

/** Monday of the local week containing `d`, at local midnight. */
function startOfLocalWeek(d: Date): Date {
  const start = startOfLocalDay(d);
  const day = start.getDay(); // 0=Sun..6=Sat
  const diff = day === 0 ? -6 : 1 - day;
  start.setDate(start.getDate() + diff);
  return start;
}

/** Parses a `?date=YYYY-MM-DD` deep link (e.g. from "View in calendar"). */
function parseDateParam(value: string | null): Date | null {
  if (value === null) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const [, year, month, day] = match;
  const date = new Date(Number(year), Number(month) - 1, Number(day));
  return Number.isNaN(date.getTime()) ? null : date;
}

export const RoomCalendarPage = () => {
  const { roomUid } = useParams<{ roomUid: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { showError } = useToast();
  const { showUuids } = useSettings();

  const [view, setView] = useState<ViewMode>('week');
  const [anchorDate, setAnchorDate] = useState(
    () => parseDateParam(searchParams.get('date')) ?? new Date(),
  );
  const [hourRangeIndex, setHourRangeIndex] = useState(0);

  const [scheduleDialogOpen, setScheduleDialogOpen] = useState(false);
  const [windowDialogOpen, setWindowDialogOpen] = useState(false);
  const [onDemandOpen, setOnDemandOpen] = useState(false);

  const rangeStart =
    view === 'day' ? startOfLocalDay(anchorDate) : startOfLocalWeek(anchorDate);
  const rangeDays = view === 'day' ? 1 : 7;
  const rangeEnd = new Date(rangeStart.getTime() + rangeDays * MS_PER_DAY);
  const hourRange = hourRangeAt(hourRangeIndex);

  const {
    data: room,
    loading,
    error: roomError,
  } = useAsyncData<Room>(
    () =>
      roomUid === undefined
        ? Promise.reject(new ApiError('NOT_FOUND', 'No room id.', 404))
        : adminApi.getRoom(roomUid),
    [roomUid],
  );
  const misconfigured = isApiErrorCode(roomError, 'BACKEND_MISCONFIGURATION');

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
            .listSessions({
              roomUids: [roomUid],
              from: rangeStart.toISOString(),
              to: rangeEnd.toISOString(),
            })
            .then((res) => res.items),
    [roomUid, view, rangeStart.getTime(), rangeEnd.getTime()],
  );
  const sessions = sessionsData ?? [];
  const sessionsOutsideHours = sessions.filter((s) =>
    isOutsideHourWindow(s, hourRange.startHour, hourRange.endHour),
  ).length;

  // Non-misconfiguration load failures are surfaced as a toast, once per error.
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
      sessionsError !== null &&
      !isApiErrorCode(sessionsError, 'BACKEND_MISCONFIGURATION')
    ) {
      showError(errorMessage(sessionsError, 'Failed to load sessions.'));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps, @eslint-react/exhaustive-deps
  }, [sessionsError]);

  const columns: CalendarColumn[] =
    view === 'day'
      ? [
          {
            key: localDateKey(rangeStart),
            label: rangeStart.toLocaleDateString('en-US', {
              weekday: 'short',
              month: 'numeric',
              day: 'numeric',
            }),
          },
        ]
      : Array.from({ length: 7 }, (_, i) => {
          const d = new Date(rangeStart.getTime() + i * MS_PER_DAY);
          return {
            key: localDateKey(d),
            label: d.toLocaleDateString('en-US', {
              weekday: 'short',
              month: 'numeric',
              day: 'numeric',
            }),
          };
        });

  // Fixed once per mount: computing "now" directly during render would make
  // the horizon drift on every re-render (impure render, flagged by
  // react-hooks/purity and @eslint-react/purity). A `useState` lazy
  // initializer — unlike `useMemo`, which still runs the callback during
  // render — is the accepted "compute once" idiom for this, per
  // room-scheduling-page.tsx's `now` state.
  const [horizonEnd] = useState(
    () => new Date(Date.now() + MATERIALIZATION_HORIZON_DAYS * MS_PER_DAY),
  );
  const isBeyondHorizon = rangeStart.getTime() > horizonEnd.getTime();

  const navigateDate = (direction: -1 | 0 | 1) => {
    if (direction === 0) {
      setAnchorDate(new Date());
      return;
    }
    const stepDays = view === 'day' ? 1 : 7;
    setAnchorDate(
      new Date(anchorDate.getTime() + direction * stepDays * MS_PER_DAY),
    );
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
      <Stack
        direction="row"
        sx={{
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: 2,
          mb: 2,
        }}
      >
        <Typography variant="h5" component="h1">
          <NameWithUid name={room.name} uid={room.uid} showUid={showUuids} /> —
          Calendar
        </Typography>
        <ButtonGroup>
          <Button
            variant={view === 'week' ? 'contained' : 'outlined'}
            onClick={() => {
              setView('week');
            }}
          >
            Week
          </Button>
          <Button
            variant={view === 'day' ? 'contained' : 'outlined'}
            onClick={() => {
              setView('day');
            }}
          >
            Day
          </Button>
        </ButtonGroup>
      </Stack>
      <Stack
        direction="row"
        spacing={1}
        sx={{
          alignItems: 'center',
          mb: 2,
        }}
      >
        <Button
          size="small"
          onClick={() => {
            navigateDate(-1);
          }}
        >
          Prev
        </Button>
        <Button
          size="small"
          onClick={() => {
            navigateDate(0);
          }}
        >
          Today
        </Button>
        <Button
          size="small"
          onClick={() => {
            navigateDate(1);
          }}
        >
          Next
        </Button>
        <Typography
          variant="body2"
          sx={{
            color: 'text.secondary',
            ml: 1,
          }}
        >
          {rangeStart.toLocaleDateString()} –{' '}
          {new Date(rangeEnd.getTime() - MS_PER_DAY).toLocaleDateString()}
        </Typography>
        <Button
          size="small"
          variant="outlined"
          sx={{ ml: 'auto' }}
          onClick={() => {
            setHourRangeIndex((i) => nextHourRangeIndex(i));
          }}
        >
          {hourRange.label}
        </Button>
      </Stack>
      {isBeyondHorizon && (
        <Alert severity="info" sx={{ mb: 2 }}>
          Sessions are only materialized up to {MATERIALIZATION_HORIZON_DAYS}{' '}
          days out — this view may look sparse or empty beyond that point.
        </Alert>
      )}
      {sessionsOutsideHours > 0 && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          {sessionsOutsideHours}{' '}
          {sessionsOutsideHours === 1 ? 'session' : 'sessions'} in this range{' '}
          {sessionsOutsideHours === 1 ? 'falls' : 'fall'} outside the visible{' '}
          {hourRange.label} window and{' '}
          {sessionsOutsideHours === 1 ? "isn't" : "aren't"} fully shown below —
          switch the hour range button above to see{' '}
          {sessionsOutsideHours === 1 ? 'it' : 'them'}.
        </Alert>
      )}
      <Stack
        direction="row"
        spacing={2}
        sx={{
          flexWrap: 'wrap',
          mb: 2,
        }}
      >
        <Button
          variant="outlined"
          startIcon={<AddIcon />}
          onClick={() => {
            setScheduleDialogOpen(true);
          }}
        >
          New schedule
        </Button>
        <Button
          variant="outlined"
          startIcon={<AddIcon />}
          onClick={() => {
            setWindowDialogOpen(true);
          }}
        >
          New auto-window
        </Button>
        <Button
          variant="outlined"
          startIcon={<AddIcon />}
          onClick={() => {
            setOnDemandOpen(true);
          }}
        >
          New on-demand
        </Button>
      </Stack>
      {sessionsLoading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
          <CircularProgress size={28} />
        </Box>
      ) : (
        <SessionCalendarGrid
          columns={columns}
          sessions={sessions}
          getColumnKeyForSession={(s) =>
            view === 'day'
              ? (columns[0]?.key ?? '')
              : localDateKey(new Date(s.effectiveStart))
          }
          dayStartHour={hourRange.startHour}
          dayEndHour={hourRange.endHour}
          onSessionClick={(s) => {
            void navigate(`/sessions/${s.uid}`);
          }}
          showUuids={showUuids}
        />
      )}
      <Box sx={{ mt: 3 }}>
        <Button component={RouterLink} to={`/rooms/${room.uid}/scheduling`}>
          Manage schedules & windows
        </Button>
      </Box>
      {scheduleDialogOpen && (
        <ScheduleDialog
          roomUid={room.uid}
          roomName={room.name}
          roomTimezone={room.timezone}
          schedule={null}
          onClose={() => {
            setScheduleDialogOpen(false);
          }}
          onSaved={() => {
            setScheduleDialogOpen(false);
            reloadSessions();
          }}
        />
      )}
      {windowDialogOpen && (
        <AutoWindowDialog
          roomUid={room.uid}
          roomName={room.name}
          roomTimezone={room.timezone}
          window={null}
          onClose={() => {
            setWindowDialogOpen(false);
          }}
          onSaved={() => {
            setWindowDialogOpen(false);
            reloadSessions();
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
    </Box>
  );
};
