import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

import { useAppSelector } from '#src/store/use-redux';

import { KioskLifecycle } from '../services/kiosk-service-status';
import {
  selectActiveSession,
  selectDevice,
  selectLifecycle,
  selectRoom,
} from '../stores/kiosk-slice';
import { JoinCodeQrCode } from './join-code-qr-code';
import { KioskActivationForm } from './kiosk-activation-form';

/**
 * Side-panel component that displays the current kiosk status. Shows the
 * `KioskActivationForm` when the device is not yet registered, and otherwise
 * renders the device/room name plus active session info.
 */
export const KioskStatusPanel = () => {
  const lifecycle = useAppSelector(selectLifecycle);
  const device = useAppSelector(selectDevice);
  const room = useAppSelector(selectRoom);
  const activeSession = useAppSelector(selectActiveSession);

  return (
    <Stack
      direction="row"
      sx={{
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
      }}
    >
      <Paper
        sx={{
          width: '90%',
          minHeight: '40%',
          padding: 2,
        }}
      >
        {lifecycle === KioskLifecycle.UNREGISTERED ? (
          <KioskActivationForm />
        ) : (
          <Stack spacing={2}>
            {device && (
              // Status lines, not section headings: keep the visual size but
              // render as text so they don't pollute the heading outline. SC 1.3.1
              <Typography variant="h5" component="p">
                Device: {device.name}
              </Typography>
            )}
            {room && <Typography>Room: {room.name}</Typography>}
            {lifecycle === KioskLifecycle.INITIALIZING && (
              <Typography>Initializing...</Typography>
            )}
            {lifecycle === KioskLifecycle.IDLE && (
              <Typography>Inactive, waiting for a session to start.</Typography>
            )}
            {activeSession && (
              <>
                <Typography>Session: {activeSession.name}</Typography>
                {activeSession.currentJoinCode && (
                  <>
                    <Typography
                      variant="h4"
                      component="p"
                      sx={{
                        fontFamily: 'monospace',
                      }}
                    >
                      Join Code: {activeSession.currentJoinCode.joinCode}
                    </Typography>
                    <JoinCodeQrCode
                      joinCode={activeSession.currentJoinCode.joinCode}
                    />
                  </>
                )}
              </>
            )}
          </Stack>
        )}
      </Paper>
    </Stack>
  );
};
