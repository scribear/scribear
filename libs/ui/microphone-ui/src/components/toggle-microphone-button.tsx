import MicIcon from '@mui/icons-material/Mic';
import MicOffIcon from '@mui/icons-material/MicOff';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';

/**
 * Props for {@link ToggleMicrophoneButton}.
 */
interface ToggleMicrophoneButtonProps {
  // Whether the microphone is currently active.
  isMicrophoneActive: boolean;
  // Called when the user activates the microphone.
  activate: () => void;
  // Called when the user deactivates the microphone.
  deactivate: () => void;
}

/**
 * Button that activates or deactivates the microphone.
 */
export const ToggleMicrophoneButton = ({
  isMicrophoneActive,
  activate,
  deactivate,
}: ToggleMicrophoneButtonProps) => {
  const toggleMicrophone = () => {
    if (isMicrophoneActive) {
      deactivate();
    } else {
      activate();
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
