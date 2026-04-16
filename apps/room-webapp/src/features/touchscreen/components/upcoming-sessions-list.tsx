import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemText from '@mui/material/ListItemText';
import Typography from '@mui/material/Typography';

import { selectUpcomingSessions } from '#src/features/room-provider/stores/room-service-slice';
import { useAppSelector } from '#src/store/use-redux';

export const UpcomingSessionsList = () => {
  const sessions = useAppSelector(selectUpcomingSessions);

  if (sessions.length === 0) {
    return (
      <Typography color="text.secondary">
        No upcoming sessions scheduled.
      </Typography>
    );
  }

  return (
    <List>
      {sessions.map((session) => {
        const start = new Date(session.startTime);
        const end = session.endTime ? new Date(session.endTime) : null;

        return (
          <ListItem key={session.sessionId} divider>
            <ListItemText
              primary={
                session.isActive
                  ? `Active session (started ${start.toLocaleTimeString()})`
                  : `Session at ${start.toLocaleTimeString()}`
              }
              secondary={
                end ? `Ends at ${end.toLocaleTimeString()}` : 'No scheduled end time'
              }
            />
          </ListItem>
        );
      })}
    </List>
  );
};
