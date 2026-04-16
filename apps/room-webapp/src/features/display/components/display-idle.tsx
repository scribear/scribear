import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Divider from '@mui/material/Divider';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import EventIcon from '@mui/icons-material/Event';
import AccessTimeIcon from '@mui/icons-material/AccessTime';

import { selectDeviceName } from '#src/features/room-provider/stores/room-config-slice';
import { selectUpcomingSessions } from '#src/features/room-provider/stores/room-service-slice';
import { useAppSelector } from '#src/store/use-redux';

/** Returns e.g. "2:30 PM" or "2:30 – 3:45 PM" */
function formatSessionTime(startMs: number, endMs: number | null): string {
  const fmt = (ms: number) =>
    new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return endMs ? `${fmt(startMs)} – ${fmt(endMs)}` : fmt(startMs);
}

/** Returns minutes until a session starts (negative if already started) */
function minutesUntil(startMs: number): number {
  return Math.round((startMs - Date.now()) / 60_000);
}

export const DisplayIdle = () => {
  const deviceName = useAppSelector(selectDeviceName);
  const upcomingSessions = useAppSelector(selectUpcomingSessions);

  const nextSession = upcomingSessions.find((s) => !s.isActive) ?? null;
  const minsUntilNext = nextSession ? minutesUntil(nextSession.startTime) : null;

  return (
    <Box
      sx={{
        height: '100vh',
        display: 'flex',
        flexDirection: 'column',
        bgcolor: 'background.default',
        overflow: 'hidden',
      }}
    >
      {/* Header */}
      <Stack
        direction="row"
        alignItems="center"
        justifyContent="space-between"
        px={4}
        py={1.5}
        sx={{ flexShrink: 0, borderBottom: '1px solid rgba(255,255,255,0.08)' }}
      >
        <Typography variant="h6" fontWeight={700}>
          {deviceName ?? 'Room Display'}
        </Typography>
        <Chip
          label="No Active Session"
          variant="outlined"
          size="small"
          sx={{ borderColor: 'rgba(255,255,255,0.2)', color: 'rgba(255,255,255,0.5)' }}
        />
      </Stack>

      {/* Body */}
      <Box
        sx={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: upcomingSessions.length === 0 ? 'center' : 'flex-start',
          px: 6,
          py: 4,
          overflow: 'hidden',
        }}
      >
        {upcomingSessions.length === 0 ? (
          /* Nothing scheduled */
          <Stack alignItems="center" spacing={2}>
            <EventIcon sx={{ fontSize: 56, color: 'rgba(255,255,255,0.15)' }} />
            <Typography variant="h5" color="rgba(255,255,255,0.35)" fontWeight={300}>
              No sessions scheduled for today
            </Typography>
          </Stack>
        ) : (
          <Box sx={{ width: '100%', maxWidth: 720 }}>
            {/* "Up next in X min" banner */}
            {minsUntilNext !== null && minsUntilNext > 0 && minsUntilNext <= 60 && (
              <Stack
                direction="row"
                alignItems="center"
                spacing={1.5}
                mb={3}
                sx={{
                  px: 2.5,
                  py: 1.5,
                  borderRadius: 2,
                  bgcolor: 'rgba(255,193,7,0.1)',
                  border: '1px solid rgba(255,193,7,0.25)',
                }}
              >
                <AccessTimeIcon sx={{ fontSize: 20, color: 'warning.main' }} />
                <Typography variant="body1" color="warning.main" fontWeight={600}>
                  Next session starts in {minsUntilNext} minute{minsUntilNext !== 1 ? 's' : ''}
                </Typography>
              </Stack>
            )}

            {/* Session list label */}
            <Typography
              variant="overline"
              color="rgba(255,255,255,0.4)"
              sx={{ letterSpacing: 2, mb: 2, display: 'block' }}
            >
              Upcoming Sessions
            </Typography>

            {/* Session cards */}
            <Stack spacing={1.5} divider={<Divider sx={{ borderColor: 'rgba(255,255,255,0.06)' }} />}>
              {upcomingSessions.map((session, idx) => {
                const timeLabel = formatSessionTime(session.startTime, session.endTime);
                const mins = minutesUntil(session.startTime);
                const isNext = !session.isActive && idx === upcomingSessions.findIndex((s) => !s.isActive);
                const durationMs = session.endTime ? session.endTime - session.startTime : null;
                const durationMin = durationMs ? Math.round(durationMs / 60_000) : null;

                return (
                  <Stack
                    key={session.sessionId}
                    direction="row"
                    alignItems="center"
                    spacing={3}
                    sx={{
                      py: 1.5,
                      px: 2,
                      borderRadius: 2,
                      bgcolor: isNext
                        ? 'rgba(255,255,255,0.05)'
                        : 'transparent',
                    }}
                  >
                    {/* Time column */}
                    <Box sx={{ minWidth: 160, flexShrink: 0 }}>
                      <Typography
                        variant="h5"
                        fontWeight={isNext ? 700 : 400}
                        sx={{
                          color: isNext ? '#ffffff' : 'rgba(255,255,255,0.55)',
                          fontVariantNumeric: 'tabular-nums',
                        }}
                      >
                        {timeLabel}
                      </Typography>
                    </Box>

                    {/* Duration */}
                    {durationMin !== null && (
                      <Typography
                        variant="body2"
                        sx={{ color: 'rgba(255,255,255,0.35)', minWidth: 80 }}
                      >
                        {durationMin} min
                      </Typography>
                    )}

                    {/* "Up next" or countdown badge */}
                    {isNext && mins > 0 && mins <= 120 && (
                      <Chip
                        label={mins <= 60 ? `in ${mins} min` : `in ${Math.round(mins / 60)} hr`}
                        size="small"
                        sx={{
                          bgcolor: 'rgba(255,255,255,0.1)',
                          color: 'rgba(255,255,255,0.7)',
                          fontWeight: 600,
                          height: 24,
                        }}
                      />
                    )}
                    {isNext && (mins <= 0 || mins > 120) && (
                      <Chip
                        label="Up next"
                        size="small"
                        sx={{
                          bgcolor: 'rgba(255,255,255,0.1)',
                          color: 'rgba(255,255,255,0.7)',
                          fontWeight: 600,
                          height: 24,
                        }}
                      />
                    )}
                  </Stack>
                );
              })}
            </Stack>
          </Box>
        )}
      </Box>
    </Box>
  );
};
