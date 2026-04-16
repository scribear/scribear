import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import EventIcon from '@mui/icons-material/Event';
import RadioButtonCheckedIcon from '@mui/icons-material/RadioButtonChecked';

import { selectUpcomingSessions } from '#src/features/room-provider/stores/room-service-slice';
import { useAppSelector } from '#src/store/use-redux';

export const UpcomingSessionsList = () => {
  const sessions = useAppSelector(selectUpcomingSessions);

  if (sessions.length === 0) {
    return (
      <Stack alignItems="center" justifyContent="center" py={2} spacing={0.5}>
        <EventIcon sx={{ fontSize: 28, color: 'text.disabled' }} />
        <Typography variant="body2" color="text.disabled" textAlign="center">
          No upcoming sessions today
        </Typography>
      </Stack>
    );
  }

  return (
    <Stack spacing={1}>
      {sessions.map((session) => {
        const start = new Date(session.startTime);
        const end = session.endTime ? new Date(session.endTime) : null;
        const timeLabel = `${start.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}${
          end
            ? ` – ${end.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
            : ''
        }`;

        return (
          <Box
            key={session.sessionId}
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 1.5,
              px: 1.5,
              py: 1,
              borderRadius: 2,
              bgcolor: session.isActive
                ? 'rgba(76,175,80,0.12)'
                : 'rgba(255,255,255,0.04)',
              border: '1px solid',
              borderColor: session.isActive
                ? 'rgba(76,175,80,0.3)'
                : 'rgba(255,255,255,0.06)',
            }}
          >
            {session.isActive ? (
              <RadioButtonCheckedIcon
                sx={{ fontSize: 14, color: 'success.main', flexShrink: 0 }}
              />
            ) : (
              <EventIcon
                sx={{ fontSize: 14, color: 'text.disabled', flexShrink: 0 }}
              />
            )}
            <Typography
              variant="body2"
              fontWeight={session.isActive ? 600 : 400}
              color={session.isActive ? 'success.main' : 'text.primary'}
              sx={{ flex: 1, minWidth: 0 }}
            >
              {timeLabel}
            </Typography>
            {session.isActive && (
              <Typography variant="caption" color="success.main" fontWeight={600}>
                ACTIVE
              </Typography>
            )}
          </Box>
        );
      })}
    </Stack>
  );
};
