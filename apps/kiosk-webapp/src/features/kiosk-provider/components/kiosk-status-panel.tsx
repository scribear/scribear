import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

import { useAppSelector } from '#src/store/use-redux';

import { KioskServiceStatus } from '../services/kiosk-service-status';
import {
  selectActiveSessionId,
  selectDeviceName,
} from '../stores/kiosk-config-slice';
import {
  selectJoinCode,
  selectKioskServiceStatus,
  selectSessionStatus,
} from '../stores/kiosk-service-slice';
import { KioskActivationForm } from './kiosk-activation-form';

/**
 * Side-panel component that displays the current kiosk status. Shows the
 * `KioskActivationForm` when the device is not yet registered, and otherwise
 * renders the device name and active session ID (if connected).
 */
export const KioskStatusPanel = () => {
  const deviceName = useAppSelector(selectDeviceName);
  const sessionId = useAppSelector(selectActiveSessionId);
  const kioskServiceStatus = useAppSelector(selectKioskServiceStatus);
  const sessionStatus = useAppSelector(selectSessionStatus);
  const joinCode = useAppSelector(selectJoinCode);

  const isNotActivated =
    kioskServiceStatus === KioskServiceStatus.NOT_REGISTERED ||
    kioskServiceStatus === KioskServiceStatus.REGISTERING ||
    kioskServiceStatus === KioskServiceStatus.REGISTRATION_ERROR;

  const isIdle = kioskServiceStatus === KioskServiceStatus.IDLE;

  const isInSession =
    kioskServiceStatus === KioskServiceStatus.SESSION_CONNECTING ||
    kioskServiceStatus === KioskServiceStatus.SESSION_ERROR ||
    kioskServiceStatus === KioskServiceStatus.ACTIVE ||
    kioskServiceStatus === KioskServiceStatus.ACTIVE_MUTE;

  return (
    <Stack
      sx={{ height: '100%' }}
      direction="row"
      alignItems="center"
      justifyContent="center"
    >
      <Paper
        sx={{
          width: '90%',
          minHeight: '40%',
          padding: 2,
        }}
      >
        {isNotActivated ? (
          <KioskActivationForm />
        ) : (
          <Stack spacing={2}>
            <Typography variant="h5">Device Name: {deviceName} </Typography>
            {isIdle && (
              <Typography>Inactive, waiting for a session to start.</Typography>
            )}
            {isInSession && (
              <>
                <Typography>Connected to session: {sessionId}</Typography>
                {joinCode && (
                  <Typography variant="h4" fontFamily="monospace">
                    Join Code: {joinCode}
                  </Typography>
                )}
                {sessionStatus && !sessionStatus.sourceDeviceConnected && (
                  <Typography color="warning.main">
                    Waiting for source device
                  </Typography>
                )}
                {sessionStatus &&
                  !sessionStatus.transcriptionServiceConnected && (
                    <Typography color="warning.main">
                      Waiting for transcription service
                    </Typography>
                  )}
              </>
            )}
          </Stack>
        )}
      </Paper>
    </Stack>
  );
};
