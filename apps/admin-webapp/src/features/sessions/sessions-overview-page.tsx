import { useEffect, useState } from 'react';

import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemText from '@mui/material/ListItemText';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

import { useNavigate } from 'react-router-dom';

import type { Session } from '@scribear/session-manager-schema';

import { adminApi } from '#src/lib/admin-api';
import { isApiErrorCode } from '#src/lib/api-error';
import {
  GRID_MAX_COLUMNS,
  defaultRoomSelection,
  hourRangeAt,
  nextHourRangeIndex,
} from '#src/lib/session-rules';
import { useSettings } from '#src/lib/settings-context';
import { useToast } from '#src/lib/toast-context';
import { useAsyncData } from '#src/lib/use-async-data';
import { useSelectedRooms } from '#src/lib/use-selected-rooms';

import { errorMessage } from '../scheduling/scheduling-form-helpers';
import { RoomPicker } from './room-picker';
import {
  type CalendarColumn,
  SessionCalendarGrid,
} from './session-calendar-grid';
import { isOutsideHourWindow } from './session-calendar-grid.utils';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function startOfLocalDay(d: Date): Date {
  const copy = new Date(d);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

export const SessionsOverviewPage = () => {
  const navigate = useNavigate();
  const { showError } = useToast();
  const { showUuids } = useSettings();

  const [selectedRooms, setSelectedRooms] = useSelectedRooms();
  // Seeded synchronously from the initial `selectedRooms` (itself a
  // synchronous localStorage read, see useSelectedRooms) rather than set from
  // inside the effect below: that keeps the effect's only setState call
  // safely async (inside the fetch's `.finally`), so it doesn't need to
  // suppress `set-state-in-effect`.
  const [defaultApplied, setDefaultApplied] = useState(
    () => selectedRooms.length > 0,
  );
  const [anchorDate, setAnchorDate] = useState(() => new Date());
  const [hourRangeIndex, setHourRangeIndex] = useState(0);

  const rangeStart = startOfLocalDay(anchorDate);
  const rangeEnd = new Date(rangeStart.getTime() + MS_PER_DAY);
  const selectedRoomUids = selectedRooms.map((r) => r.uid);
  const selectedRoomsKey = selectedRoomUids.join(',');
  const rangeStartMs = rangeStart.getTime();
  const rangeEndMs = rangeEnd.getTime();
  const hourRange = hourRangeAt(hourRangeIndex);
  const isGridMode =
    selectedRooms.length > 0 && selectedRooms.length <= GRID_MAX_COLUMNS;

  // On first load with no persisted selection, default to "show everything"
  // for small deployments, or nothing for large ones (§4.5) — run once.
  useEffect(() => {
    if (defaultApplied) return;
    const alive = { current: true };
    adminApi
      .listRooms({ limit: GRID_MAX_COLUMNS + 1 })
      .then((res) => {
        if (!alive.current) return;
        setSelectedRooms(
          defaultRoomSelection(res.items, res.nextCursor !== null),
        );
      })
      .catch(() => {
        // Best-effort default; leave selection empty on error.
      })
      .finally(() => {
        if (alive.current) setDefaultApplied(true);
      });
    return () => {
      alive.current = false;
    };
    // Run once on mount; `defaultApplied` starts correctly seeded (see above)
    // so this never needs to re-run.
    // eslint-disable-next-line react-hooks/exhaustive-deps, @eslint-react/exhaustive-deps
  }, []);

  const {
    data: sessionsData,
    loading: sessionsLoading,
    error: sessionsError,
  } = useAsyncData<Session[]>(
    () =>
      selectedRooms.length === 0
        ? Promise.resolve([])
        : adminApi
            .listSessions({
              roomUids: selectedRoomUids,
              from: rangeStart.toISOString(),
              to: rangeEnd.toISOString(),
            })
            .then((res) => res.items),
    [selectedRoomsKey, rangeStartMs, rangeEndMs],
  );
  const sessions = sessionsData ?? [];
  const misconfigured = isApiErrorCode(
    sessionsError,
    'BACKEND_MISCONFIGURATION',
  );
  const sessionsOutsideHours = isGridMode
    ? sessions.filter((s) =>
        isOutsideHourWindow(s, hourRange.startHour, hourRange.endHour),
      ).length
    : 0;

  // Non-misconfiguration load failures are surfaced as a toast, once per error.
  useEffect(() => {
    if (
      sessionsError !== null &&
      !isApiErrorCode(sessionsError, 'BACKEND_MISCONFIGURATION')
    ) {
      showError(errorMessage(sessionsError, 'Failed to load sessions.'));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps, @eslint-react/exhaustive-deps
  }, [sessionsError]);

  const navigateDate = (direction: -1 | 0 | 1) => {
    setAnchorDate(
      direction === 0
        ? new Date()
        : new Date(anchorDate.getTime() + direction * MS_PER_DAY),
    );
  };

  const columns: CalendarColumn[] = selectedRooms.map((r) => ({
    key: r.uid,
    label: r.name,
  }));

  const sessionsByRoom = new Map<string, Session[]>(
    selectedRooms.map((r) => [r.uid, []]),
  );
  for (const s of sessions) {
    sessionsByRoom.get(s.roomUid)?.push(s);
  }

  return (
    <Box>
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
          Sessions
        </Typography>
      </Stack>
      {misconfigured && (
        <Alert severity="error" sx={{ mb: 2 }}>
          Admin backend misconfiguration — an operator must check the
          server&apos;s ADMIN_API_KEY.
        </Alert>
      )}
      <Box sx={{ mb: 2, maxWidth: 600 }}>
        <RoomPicker selected={selectedRooms} onChange={setSelectedRooms} />
      </Box>
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
          {rangeStart.toLocaleDateString()}
        </Typography>
        {isGridMode && (
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
        )}
      </Stack>
      {sessionsOutsideHours > 0 && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          {sessionsOutsideHours}{' '}
          {sessionsOutsideHours === 1 ? 'session' : 'sessions'} today{' '}
          {sessionsOutsideHours === 1 ? 'falls' : 'fall'} outside the visible{' '}
          {hourRange.label} window and{' '}
          {sessionsOutsideHours === 1 ? "isn't" : "aren't"} fully shown below —
          switch the hour range button above to see{' '}
          {sessionsOutsideHours === 1 ? 'it' : 'them'}.
        </Alert>
      )}
      {selectedRooms.length === 0 ? (
        <Paper variant="outlined" sx={{ p: 4, textAlign: 'center' }}>
          <Typography
            sx={{
              color: 'text.secondary',
            }}
          >
            Select rooms above to view their calendar.
          </Typography>
        </Paper>
      ) : sessionsLoading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
          <CircularProgress size={28} />
        </Box>
      ) : isGridMode ? (
        <SessionCalendarGrid
          columns={columns}
          sessions={sessions}
          getColumnKeyForSession={(s) => s.roomUid}
          dayStartHour={hourRange.startHour}
          dayEndHour={hourRange.endHour}
          onSessionClick={(s) => {
            void navigate(`/sessions/${s.uid}`);
          }}
          showUuids={showUuids}
        />
      ) : (
        <Stack spacing={2}>
          {selectedRooms.map((room) => {
            const roomSessions = sessionsByRoom.get(room.uid) ?? [];
            return (
              <Paper key={room.uid} variant="outlined">
                {/* `component="h2"`, not h3: this page's only other heading is
                    the `h1` page title above (no intervening section `h2`
                    exists on this page), so each room card is the first
                    subsection level directly under the page title. h3 here
                    would skip a level and fail axe's heading-order rule —
                    the same gotcha already documented for `subtitle2`
                    mapping to `<h6>` by default. */}
                <Typography
                  variant="subtitle2"
                  component="h2"
                  sx={{ p: 1, borderBottom: 1, borderColor: 'divider' }}
                >
                  {room.name}
                </Typography>
                {roomSessions.length === 0 ? (
                  <Typography
                    variant="body2"
                    sx={{
                      color: 'text.secondary',
                      p: 2,
                    }}
                  >
                    No sessions today.
                  </Typography>
                ) : (
                  <List dense disablePadding>
                    {roomSessions.map((session) => (
                      <ListItemButton
                        key={session.uid}
                        onClick={() => {
                          void navigate(`/sessions/${session.uid}`);
                        }}
                      >
                        <ListItemText
                          primary={session.name}
                          secondary={new Date(
                            session.effectiveStart,
                          ).toLocaleTimeString([], {
                            hour: 'numeric',
                            minute: '2-digit',
                          })}
                        />
                        {session.canceledAt !== null && (
                          <Chip size="small" label="Canceled" />
                        )}
                      </ListItemButton>
                    ))}
                  </List>
                )}
              </Paper>
            );
          })}
        </Stack>
      )}
    </Box>
  );
};
