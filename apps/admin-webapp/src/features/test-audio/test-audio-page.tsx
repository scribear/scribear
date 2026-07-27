import Alert from '@mui/material/Alert';
import AlertTitle from '@mui/material/AlertTitle';
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import Grid from '@mui/material/Grid';
import Typography from '@mui/material/Typography';

import { ApiError } from '#src/lib/api-error';

import { FaultSourceCard } from './fault-source-card';
import { GoodSourceCard } from './good-source-card';
import { useTestAudio } from './use-test-audio';

/**
 * Operator test-audio devices (`PLAN-TestAudioDevices.md` §4).
 *
 * Two synthetic sources pointed at their own rooms, parameterized live: one
 * plays good speech at a level you choose, the other reproduces every audio
 * fault the stack claims to report. The point of the page is turning a knob and
 * watching a meter move, so the device list is polled every 3 s and a change to
 * a running device retunes it in place rather than restarting the stream.
 */
export const TestAudioPage = () => {
  const { available, devices, loading, error, refresh } = useTestAudio();

  const good = devices.find((d) => d.deviceId === 'good');
  const fault = devices.find((d) => d.deviceId === 'fault');

  return (
    <Box>
      <Typography variant="h5" component="h1" sx={{ mb: 1 }}>
        Test audio
      </Typography>
      <Typography variant="body2" sx={{ color: 'text.secondary', mb: 2 }}>
        Two synthetic source devices, each permanently assigned to its own test
        room. <strong>The room assignment is the entire safety boundary</strong>{' '}
        — a device token can only reach sessions in its own device&apos;s room,
        so neither source here can stream into a teaching room. Every run
        auto-stops at the duration you set, so a forgotten device cannot stream
        overnight.
      </Typography>

      {/* A failed poll is reported inline, not as a toast: the poll repeats
          every 3 s, and a toast per failure would stack up faster than an
          operator can dismiss them. The last-known device state stays on
          screen underneath. */}
      {error !== null && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          {error instanceof ApiError
            ? error.message
            : 'Could not read the test-audio devices.'}{' '}
          The readings below may be stale.
        </Alert>
      )}

      {loading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', p: 4 }}>
          <CircularProgress />
        </Box>
      ) : available === false ? (
        <Alert severity="info">
          <AlertTitle>Test audio devices are not configured here</AlertTitle>
          This deployment has no test-audio generator:{' '}
          <code>TEST_AUDIO_BASE_URL</code> is unset on the admin server, so
          there is nothing to start and no device to start it on. To enable it,
          set <code>TEST_AUDIO_DEVICE_SECRET</code> to the same value on the
          session manager and the <code>test-audio-generator</code> service —
          which seeds the two rooms and devices for you — and point{' '}
          <code>TEST_AUDIO_BASE_URL</code> at the generator. Nothing else in the
          console depends on this.
        </Alert>
      ) : (
        <Grid container spacing={2} sx={{ alignItems: 'flex-start' }}>
          <Grid size={{ xs: 12, lg: 6 }}>
            {good === undefined ? (
              <Alert severity="warning">
                The generator did not report a <code>good</code> device.
              </Alert>
            ) : (
              <GoodSourceCard device={good} refresh={refresh} />
            )}
          </Grid>
          <Grid size={{ xs: 12, lg: 6 }}>
            {fault === undefined ? (
              <Alert severity="warning">
                The generator did not report a <code>fault</code> device.
              </Alert>
            ) : (
              <FaultSourceCard device={fault} refresh={refresh} />
            )}
          </Grid>
        </Grid>
      )}
    </Box>
  );
};
