import Button from '@mui/material/Button';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

import {
  activateMicrophone,
  deactivateMicrophone,
  selectIsMicrophoneServiceActive,
} from '@scribear/microphone-store';

import { KioskActivationForm } from '#src/features/kiosk-provider/components/kiosk-activation-form';
import { KioskServiceStatus } from '#src/features/kiosk-provider/services/kiosk-service-status';
import { selectActiveSessionId } from '#src/features/kiosk-provider/stores/kiosk-config-slice';
import { selectKioskServiceStatus } from '#src/features/kiosk-provider/stores/kiosk-service-slice';
import {
  requestEndSession,
  selectIsEndingSession,
  selectSessionControlError,
  setPaused,
} from '#src/features/session-controls/stores/session-controls-slice';
import { useAppDispatch, useAppSelector } from '#src/store/use-redux';

import { RecordingIndicator } from './recording-indicator';

export const SessionControlsPanel = () => {
  const dispatch = useAppDispatch();
  const sessionId = useAppSelector(selectActiveSessionId);
  const kioskStatus = useAppSelector(selectKioskServiceStatus);
  const isMicrophoneActive = useAppSelector(selectIsMicrophoneServiceActive);
  const isEndingSession = useAppSelector(selectIsEndingSession);
  const sessionControlError = useAppSelector(selectSessionControlError);

  const isInSession = Boolean(sessionId);
  const isNotActivated =
    kioskStatus === KioskServiceStatus.NOT_REGISTERED ||
    kioskStatus === KioskServiceStatus.REGISTERING ||
    kioskStatus === KioskServiceStatus.REGISTRATION_ERROR;

  return (
    <Paper sx={{ p: 3, height: '100%' }}>
      {isNotActivated ? (
        <KioskActivationForm />
      ) : (
      <Stack spacing={2}>
        <Typography variant="h5">Host Touchscreen</Typography>
        <Typography>Service status: {kioskStatus}</Typography>
        <Typography>Session: {sessionId ?? 'No active session'}</Typography>
        <RecordingIndicator isRecording={isInSession && isMicrophoneActive} />
        <Stack direction="row" spacing={2}>
          <Button
            variant="contained"
            color="warning"
            disabled={!isInSession}
            onClick={() => {
              if (isMicrophoneActive) {
                dispatch(deactivateMicrophone());
                dispatch(setPaused(true));
              } else {
                void dispatch(activateMicrophone());
                dispatch(setPaused(false));
              }
            }}
          >
            {isMicrophoneActive ? 'Pause Session' : 'Resume Session'}
          </Button>
          <Button
            variant="contained"
            color="error"
            disabled={!isInSession || isEndingSession}
            onClick={() => dispatch(requestEndSession())}
          >
            End Session Early
          </Button>
        </Stack>
        {sessionControlError ? (
          <Typography color="error.main">{sessionControlError}</Typography>
        ) : null}
      </Stack>
      )}
    </Paper>
  );
};
