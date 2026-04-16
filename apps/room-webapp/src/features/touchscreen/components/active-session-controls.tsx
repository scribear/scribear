import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Stack from '@mui/material/Stack';
import MicOffIcon from '@mui/icons-material/MicOff';
import MicIcon from '@mui/icons-material/Mic';

import { RoomServiceStatus } from '#src/features/room-provider/services/room-service-status';
import {
  muteToggle,
  selectIsMuted,
  selectRoomServiceStatus,
} from '#src/features/room-provider/stores/room-service-slice';
import { useAppDispatch, useAppSelector } from '#src/store/use-redux';

interface ActiveSessionControlsProps {
  sessionId: string;
}

export const ActiveSessionControls = ({ sessionId: _ }: ActiveSessionControlsProps) => {
  const dispatch = useAppDispatch();
  const status = useAppSelector(selectRoomServiceStatus);
  const isMuted = useAppSelector(selectIsMuted);

  const handleMuteToggle = () => {
    dispatch(muteToggle(!isMuted));
  };

  const isConnected =
    status === RoomServiceStatus.ACTIVE || status === RoomServiceStatus.ACTIVE_MUTE;

  return (
    <Stack spacing={2}>
      <Stack direction="row" alignItems="center" spacing={2}>
        <Chip label="Session in Progress" color="success" variant="filled" />
        {status === RoomServiceStatus.SESSION_CONNECTING && (
          <Chip label="Connecting…" color="warning" />
        )}
      </Stack>

      <Button
        variant="contained"
        color={isMuted ? 'warning' : 'primary'}
        startIcon={isMuted ? <MicOffIcon /> : <MicIcon />}
        onClick={handleMuteToggle}
        disabled={!isConnected}
        size="large"
        sx={{ alignSelf: 'flex-start' }}
      >
        {isMuted ? 'Unmute Microphone' : 'Mute Microphone'}
      </Button>
    </Stack>
  );
};
