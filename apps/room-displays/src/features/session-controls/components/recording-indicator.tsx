import FiberManualRecordRoundedIcon from '@mui/icons-material/FiberManualRecordRounded';
import PauseCircleRoundedIcon from '@mui/icons-material/PauseCircleRounded';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

interface RecordingIndicatorProps {
  isRecording: boolean;
}

export const RecordingIndicator = ({ isRecording }: RecordingIndicatorProps) => {
  return (
    <Stack direction="row" alignItems="center" spacing={1}>
      {isRecording ? (
        <>
          <FiberManualRecordRoundedIcon color="error" />
          <Typography variant="h6" color="error.main">
            REC
          </Typography>
        </>
      ) : (
        <>
          <PauseCircleRoundedIcon color="warning" />
          <Typography variant="h6" color="warning.main">
            Paused
          </Typography>
        </>
      )}
    </Stack>
  );
};
