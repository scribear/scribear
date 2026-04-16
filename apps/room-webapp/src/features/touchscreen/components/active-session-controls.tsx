import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import MicOffIcon from '@mui/icons-material/MicOff';
import MicIcon from '@mui/icons-material/Mic';
import RadioButtonCheckedIcon from '@mui/icons-material/RadioButtonChecked';

import { RoomServiceStatus } from '#src/features/room-provider/services/room-service-status';
import {
  muteToggle,
  selectIsMuted,
  selectRoomServiceStatus,
} from '#src/features/room-provider/stores/room-service-slice';
import { useAppDispatch, useAppSelector } from '#src/store/use-redux';

interface ActiveSessionControlsProps {
  sessionId: string;
  startTime: number | null;
  endTime: number | null;
  hasTimingInfo: boolean;
}

export const ActiveSessionControls = ({
  endTime,
  hasTimingInfo,
}: ActiveSessionControlsProps) => {
  const dispatch = useAppDispatch();
  const status = useAppSelector(selectRoomServiceStatus);
  const isMuted = useAppSelector(selectIsMuted);

  const isConnected =
    status === RoomServiceStatus.ACTIVE || status === RoomServiceStatus.ACTIVE_MUTE;

  const endTimeLabel = !hasTimingInfo
    ? 'Loading…'
    : endTime
      ? new Date(endTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : 'Open-ended';

  return (
    <Stack sx={{ height: '100%' }} spacing={0}>
      {/* Session in progress indicator */}
      <Stack direction="row" alignItems="center" spacing={1} mb={1}>
        <RadioButtonCheckedIcon sx={{ fontSize: 16, color: 'success.main' }} />
        <Typography
          variant="overline"
          color="success.main"
          sx={{ letterSpacing: 1.5, lineHeight: 1 }}
        >
          Session in Progress
        </Typography>
      </Stack>

      {/* End time — large, prominent */}
      <Box mb={2}>
        <Typography variant="caption" color="text.secondary" sx={{ letterSpacing: 0.5 }}>
          ENDS AT
        </Typography>
        <Typography variant="h3" fontWeight={700} lineHeight={1.1}>
          {endTimeLabel}
        </Typography>
      </Box>

      {/* Spacer */}
      <Box sx={{ flex: 1 }} />

      {/* Mute button — full width, very large touch target */}
      <Button
        variant="contained"
        color={isMuted ? 'error' : 'primary'}
        startIcon={isMuted ? <MicOffIcon /> : <MicIcon />}
        onClick={() => dispatch(muteToggle(!isMuted))}
        disabled={!isConnected}
        fullWidth
        sx={{
          py: 2,
          fontSize: '1.1rem',
          fontWeight: 700,
          borderRadius: 2,
          textTransform: 'none',
        }}
      >
        {isMuted ? 'Unmute Microphone' : 'Mute Microphone'}
      </Button>
    </Stack>
  );
};
