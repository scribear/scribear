import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

import { RoomServiceStatus } from '#src/features/room-provider/services/room-service-status';
import {
  selectActiveSessionId,
  selectDeviceName,
} from '#src/features/room-provider/stores/room-config-slice';
import {
  selectRoomServiceStatus,
} from '#src/features/room-provider/stores/room-service-slice';
import { useAppSelector } from '#src/store/use-redux';
import { ActiveSessionControls } from './active-session-controls';
import { DisplaySettingsPanel } from './display-settings-panel';
import { UpcomingSessionsList } from './upcoming-sessions-list';

const getStatusColor = (
  status: RoomServiceStatus,
): 'success' | 'warning' | 'error' | 'default' => {
  switch (status) {
    case RoomServiceStatus.ACTIVE:
    case RoomServiceStatus.ACTIVE_MUTE:
    case RoomServiceStatus.IDLE:
      return 'success';
    case RoomServiceStatus.SESSION_CONNECTING:
    case RoomServiceStatus.SESSION_ERROR:
      return 'warning';
    case RoomServiceStatus.ERROR:
      return 'error';
    default:
      return 'default';
  }
};

const getStatusLabel = (status: RoomServiceStatus): string => {
  switch (status) {
    case RoomServiceStatus.ACTIVE:
      return 'Connected';
    case RoomServiceStatus.ACTIVE_MUTE:
      return 'Connected (Muted)';
    case RoomServiceStatus.IDLE:
      return 'Connected';
    case RoomServiceStatus.SESSION_CONNECTING:
      return 'Connecting…';
    case RoomServiceStatus.SESSION_ERROR:
      return 'Connection Error';
    case RoomServiceStatus.ERROR:
      return 'Error';
    default:
      return 'Disconnected';
  }
};

export const HomeDisplay = () => {
  const deviceName = useAppSelector(selectDeviceName);
  const status = useAppSelector(selectRoomServiceStatus);
  const activeSessionId = useAppSelector(selectActiveSessionId);

  const isInSession =
    status === RoomServiceStatus.SESSION_CONNECTING ||
    status === RoomServiceStatus.ACTIVE ||
    status === RoomServiceStatus.ACTIVE_MUTE ||
    status === RoomServiceStatus.SESSION_ERROR;

  return (
    <Box sx={{ height: '100vh', display: 'flex', flexDirection: 'column', p: 3 }}>
      {/* Header */}
      <Stack
        direction="row"
        alignItems="center"
        justifyContent="space-between"
        mb={3}
      >
        <Typography variant="h4">{deviceName ?? 'Room Display'}</Typography>
        <Chip
          label={getStatusLabel(status)}
          color={getStatusColor(status)}
          variant="filled"
        />
      </Stack>

      {/* Content */}
      {isInSession && activeSessionId ? (
        <Stack spacing={3} flex={1}>
          <ActiveSessionControls sessionId={activeSessionId} />
          <DisplaySettingsPanel />
        </Stack>
      ) : (
        <Stack spacing={2} flex={1}>
          <Typography variant="h6" color="text.secondary">
            No active session
          </Typography>
          <UpcomingSessionsList />
        </Stack>
      )}
    </Box>
  );
};
