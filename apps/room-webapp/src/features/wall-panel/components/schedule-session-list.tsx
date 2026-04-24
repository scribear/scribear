import EventIcon from '@mui/icons-material/Event';
import RadioButtonCheckedIcon from '@mui/icons-material/RadioButtonChecked';
import Chip from '@mui/material/Chip';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

import type { UpcomingSession } from '#src/features/room-provider/stores/room-service-slice';

import { useNow } from '../hooks/use-now';
import { formatTimeTwoDigit, minutesUntil } from '../wall-panel-format';

const ROW = {
  px: 1.75,
  py: 1.25,
  borderRadius: 1.5,
  border: '1px solid',
} as const;

interface ScheduleSessionListProps {
  sessions: UpcomingSession[];
  emptyLabel?: string;
}

export const ScheduleSessionList = ({
  sessions,
  emptyLabel = 'No sessions scheduled for today.',
}: ScheduleSessionListProps) => {
  const now = useNow(30_000);

  if (sessions.length === 0) {
    return (
      <Stack alignItems="center" justifyContent="center" py={5} spacing={1}>
        <EventIcon sx={{ fontSize: 44, color: 'text.disabled' }} />
        <Typography variant="body2" color="text.secondary" textAlign="center">
          {emptyLabel}
        </Typography>
      </Stack>
    );
  }

  return (
    <Stack spacing={0.75}>
      {sessions.map((session) => {
        const end =
          session.endTime != null ? formatTimeTwoDigit(session.endTime) : null;
        const timeLabel = end
          ? `${formatTimeTwoDigit(session.startTime)} – ${end}`
          : formatTimeTwoDigit(session.startTime);
        const mins = minutesUntil(session.startTime, now);
        const active = session.isActive;

        return (
          <Stack
            key={session.sessionId}
            direction="row"
            alignItems="center"
            spacing={1.5}
            sx={{
              ...ROW,
              bgcolor: active
                ? 'rgba(76,175,80,0.1)'
                : 'rgba(255,255,255,0.03)',
              borderColor: active
                ? 'rgba(76,175,80,0.35)'
                : 'rgba(255,255,255,0.08)',
            }}
          >
            {active ? (
              <RadioButtonCheckedIcon
                sx={{ fontSize: 18, color: 'success.main' }}
              />
            ) : (
              <EventIcon sx={{ fontSize: 18, color: 'text.disabled' }} />
            )}
            <Typography
              variant="subtitle1"
              fontWeight={active ? 700 : 500}
              sx={{ flex: 1, minWidth: 0, fontVariantNumeric: 'tabular-nums' }}
            >
              {timeLabel}
            </Typography>
            {active ? (
              <Chip
                label="Live"
                size="small"
                color="success"
                sx={{ fontWeight: 700 }}
              />
            ) : mins > 0 && mins <= 120 ? (
              <Chip
                label={
                  mins <= 60
                    ? `in ${String(mins)} min`
                    : `in ${String(Math.round(mins / 60))} hr`
                }
                size="small"
                sx={{
                  bgcolor: 'rgba(255,255,255,0.08)',
                  color: 'text.secondary',
                }}
              />
            ) : null}
          </Stack>
        );
      })}
    </Stack>
  );
};
