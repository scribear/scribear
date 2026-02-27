import MicIcon from '@mui/icons-material/Mic';
import MicOffIcon from '@mui/icons-material/MicOff';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';

import {
  activateMicrophone,
  deactivateMicrophone,
} from '#src/core/microphone/stores/microphone-preferences-slice';
import { selectIsMicrophoneServiceActive } from '#src/core/microphone/stores/microphone-service-slice';
import { useAppDispatch, useAppSelector } from '#src/stores/use-redux';

export const ToggleMicrophoneButton = () => {
  const dispatch = useAppDispatch();
  const isMicrophoneActive = useAppSelector(selectIsMicrophoneServiceActive);

  const toggleMicrophone = () => {
    if (isMicrophoneActive) {
      dispatch(deactivateMicrophone());
    } else {
      dispatch(activateMicrophone());
    }
  };

  return (
    <Tooltip
      title={isMicrophoneActive ? 'Mute Microphone' : 'Unmute Microphone'}
    >
      <IconButton color="inherit" onClick={toggleMicrophone}>
        {isMicrophoneActive ? <MicIcon /> : <MicOffIcon />}
      </IconButton>
    </Tooltip>
  );
};
