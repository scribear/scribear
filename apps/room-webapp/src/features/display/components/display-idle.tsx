import Box from '@mui/material/Box';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemText from '@mui/material/ListItemText';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

import { selectDeviceName } from '#src/features/room-provider/stores/room-config-slice';
import { selectUpcomingSessions } from '#src/features/room-provider/stores/room-service-slice';
import { useAppSelector } from '#src/store/use-redux';

export const DisplayIdle = () => {
  const deviceName = useAppSelector(selectDeviceName);
  const upcomingSessions = useAppSelector(selectUpcomingSessions);

  return (
    <Box
      sx={{
        height: '100vh',
        display: 'flex',
        flexDirection: 'column',
        p: 4,
        bgcolor: 'background.default',
      }}
    >
      <Stack spacing={1} sx={{ mb: 3 }}>
        <Typography variant="h4">{deviceName ?? 'Room Display'}</Typography>
        <Typography variant="h6" color="text.secondary">
          No active session
        </Typography>
      </Stack>

      {upcomingSessions.length > 0 ? (
        <>
          <Typography variant="subtitle1" gutterBottom>
            Upcoming Sessions
          </Typography>
          <List disablePadding>
            {upcomingSessions.map((session) => {
              const start = new Date(session.startTime);
              const end = session.endTime ? new Date(session.endTime) : null;
              return (
                <ListItem key={session.sessionId} divider>
                  <ListItemText
                    primary={
                      session.isActive
                        ? `Active (started ${start.toLocaleTimeString()})`
                        : `Session at ${start.toLocaleTimeString()}`
                    }
                    secondary={
                      end ? `Ends at ${end.toLocaleTimeString()}` : 'Open-ended'
                    }
                  />
                </ListItem>
              );
            })}
          </List>
        </>
      ) : (
        <Typography variant="body1" color="text.secondary" mt={2}>
          No upcoming sessions today.
        </Typography>
      )}
    </Box>
  );
};
