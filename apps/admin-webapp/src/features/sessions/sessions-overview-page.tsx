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

import { ErrorState } from '#src/components/error-state';
import { adminApi } from '#src/lib/admin-api';
import {
  GRID_MAX_COLUMNS,
  defaultRoomSelection,
  hourRangeAt,
  nextHourRangeIndex,
} from '#src/lib/session-rules';
import { useSettings } from '#src/lib/settings-context';
import { useAsyncData } from '#src/lib/use-async-data';
import { useSelectedRooms } from '#src/lib/use-selected-rooms';

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
  // Non-null once the default-selection fetch below has failed. Kept so the
  // page can say why the picker is empty instead of telling the operator to
  // select rooms from a list that could not be read.
  const [defaultSelectionError, setDefaultSelectionError] =
    useState<unknown>(null);

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
  //
  // Also used as the "Retry" handler for the failure branch, so the operator
  // has a way out that does not require reloading the whole console.
  const applyDefaultSelection = (alive: { current: boolean }) => {
    adminApi
      .listRooms({ limit: GRID_MAX_COLUMNS + 1 })
      .then((res) => {
        if (!alive.current) return;
        setDefaultSelectionError(null);
        setSelectedRooms(
          defaultRoomSelection(res.items, res.nextCursor !== null),
        );
      })
      .catch((err: unknown) => {
        // NOT swallowed (PLAN-VisibleErrors §10.5): with no selection and no
        // message the page would show "Select rooms above to view their
        // calendar." over a picker whose own search is failing for the same
        // reason. The failure branch below states that instead.
        if (alive.current) setDefaultSelectionError(err);
      })
      .finally(() => {
        if (alive.current) setDefaultApplied(true);
      });
  };

  useEffect(() => {
    if (defaultApplied) return;
    const alive = { current: true };
    applyDefaultSelection(alive);
    return () => {
      alive.current = false;
    };
    // Run once on mount; `defaultApplied` starts correctly seeded (see above)
    // so this never needs to re-run.
    // eslint-disable-next-line react-hooks/exhaustive-deps, @eslint-react/exhaustive-deps
  }, []);

  const { state: sessionsState, reload: reloadSessions } = useAsyncData<
    Session[]
  >(
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
  // Only ever the sessions we actually read. A failed load reaches the
  // `unavailable` branch below instead of rendering "No sessions today." in
  // every room card (PLAN-VisibleErrors §5).
  const sessions = sessionsState.status === 'ok' ? sessionsState.data : [];
  const sessionsOutsideHours = isGridMode
    ? sessions.filter((s) =>
        isOutsideHourWindow(s, hourRange.startHour, hourRange.endHour),
      ).length
    : 0;

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
      {selectedRooms.length === 0 && defaultSelectionError !== null ? (
        <ErrorState
          title="Could not load the room list."
          error={defaultSelectionError}
          onRetry={() => {
            applyDefaultSelection({ current: true });
          }}
        />
      ) : selectedRooms.length === 0 ? (
        <Paper variant="outlined" sx={{ p: 4, textAlign: 'center' }}>
          <Typography
            sx={{
              color: 'text.secondary',
            }}
          >
            Select rooms above to view their calendar.
          </Typography>
        </Paper>
      ) : sessionsState.status === 'loading' ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
          <CircularProgress size={28} />
        </Box>
      ) : sessionsState.status === 'unavailable' ? (
        <ErrorState
          title="Could not load sessions."
          error={sessionsState.error}
          onRetry={reloadSessions}
        />
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
