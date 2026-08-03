import type { ReactNode } from 'react';
import { useId } from 'react';

import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import StopIcon from '@mui/icons-material/Stop';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import Divider from '@mui/material/Divider';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';

import type {
  TestAudioDeviceState,
  TestAudioRunState,
} from '#src/lib/admin-api';

import { DURATION_MAX_SEC, DURATION_MIN_SEC } from './params-meta';
import { isRunning } from './use-test-audio';

const STATE_COLOR: Record<
  TestAudioRunState,
  'default' | 'info' | 'success' | 'error'
> = {
  idle: 'default',
  connecting: 'info',
  streaming: 'success',
  error: 'error',
};

function formatRemaining(expiresAtMs: number | null): string | null {
  if (expiresAtMs === null) return null;
  const remainingSec = Math.round((expiresAtMs - Date.now()) / 1000);
  if (remainingSec <= 0) return 'expiring';
  const minutes = Math.floor(remainingSec / 60);
  const seconds = remainingSec % 60;
  return minutes > 0
    ? `${String(minutes)}m ${String(seconds)}s`
    : `${String(seconds)}s`;
}

/** One labelled reading in the card's status block. */
const Stat = ({ label, value }: { label: string; value: ReactNode }) => (
  <Box>
    <Typography
      component="dt"
      variant="caption"
      sx={{ color: 'text.secondary', display: 'block' }}
    >
      {label}
    </Typography>
    <Typography
      component="dd"
      variant="body2"
      sx={{ m: 0, overflowWrap: 'break-word' }}
    >
      {value}
    </Typography>
  </Box>
);

interface DeviceCardProps {
  device: TestAudioDeviceState;
  title: string;
  /** What this device is for, in one sentence. */
  description: string;
  /** Named so the two cards' controls are distinguishable by ear, e.g.
   *  "good source". Used to build every accessible name in the card. */
  sourceName: string;
  durationSec: number;
  onDurationChange: (durationSec: number) => void;
  /** A start/stop request is in flight. */
  busy: boolean;
  onStart: () => void;
  onStop: () => void;
  /** The device's parameter controls. */
  children: ReactNode;
}

/**
 * The frame every device card shares: identity, run state, the counters, the
 * duration field and the start/stop button. The parameters themselves differ
 * completely between the two devices and come in as `children`.
 */
export const DeviceCard = ({
  device,
  title,
  description,
  sourceName,
  durationSec,
  onDurationChange,
  busy,
  onStart,
  onStop,
  children,
}: DeviceCardProps) => {
  const headingId = useId();
  const running = isRunning(device);
  const remaining = running ? formatRemaining(device.expiresAtMs) : null;

  return (
    <Card component="section" aria-labelledby={headingId} variant="outlined">
      <CardContent>
        <Stack
          direction="row"
          spacing={1}
          sx={{ alignItems: 'center', flexWrap: 'wrap', mb: 0.5 }}
        >
          <Typography
            id={headingId}
            variant="h6"
            component="h2"
            sx={{ flexGrow: 1 }}
          >
            {title}
          </Typography>
          <Chip
            size="small"
            label={device.state}
            color={STATE_COLOR[device.state]}
          />
        </Stack>
        <Typography variant="body2" sx={{ color: 'text.secondary', mb: 2 }}>
          {description}
        </Typography>

        {!device.configured && (
          <Alert severity="info" sx={{ mb: 2 }}>
            No credential is configured for this source, so it cannot be
            started. Set <code>TEST_AUDIO_DEVICE_SECRET</code> to the same value
            on the session manager and the generator, then restart both.
          </Alert>
        )}

        {/* The state and any error are the only readings that change rarely
            enough to announce. The counters below move every poll — putting
            them in a live region would make the page unusable with a screen
            reader, so they are labelled and left silent. */}
        <Box aria-live="polite" sx={{ mb: device.error === null ? 0 : 2 }}>
          <Typography component="p" variant="body2" sx={{ mb: 1 }}>
            {running
              ? `${sourceName} is ${device.state}${
                  remaining === null ? '' : `, auto-stops in ${remaining}`
                }.`
              : `${sourceName} is idle.`}
          </Typography>
          {device.error !== null && (
            <Alert severity="error">{device.error}</Alert>
          )}
        </Box>

        <Box
          component="dl"
          sx={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))',
            gap: 1.5,
            m: 0,
            mb: 2,
          }}
        >
          <Stat label="Room" value={device.roomName ?? '—'} />
          <Stat label="Session" value={device.sessionUid ?? '—'} />
          <Stat
            label="Frames sent"
            value={device.framesSent.toLocaleString()}
          />
          <Stat
            label="Frames faulted"
            value={device.framesFaulted.toLocaleString()}
          />
          <Stat
            label="Transcripts seen"
            value={device.transcriptCount.toLocaleString()}
          />
        </Box>
        <Box sx={{ mb: 2 }}>
          <Typography
            variant="caption"
            sx={{ color: 'text.secondary', display: 'block' }}
          >
            Last transcript
          </Typography>
          <Typography variant="body2" sx={{ fontStyle: 'italic' }}>
            {device.lastTranscript ?? '—'}
          </Typography>
        </Box>

        <Divider sx={{ mb: 2 }} />
        {children}
        <Divider sx={{ my: 2 }} />

        <Stack
          direction="row"
          spacing={2}
          sx={{ alignItems: 'flex-start', flexWrap: 'wrap' }}
        >
          <TextField
            label={`Run duration for the ${sourceName} (seconds)`}
            type="number"
            size="small"
            value={durationSec}
            disabled={running}
            onChange={(e) => {
              onDurationChange(Number(e.target.value));
            }}
            slotProps={{
              htmlInput: {
                min: DURATION_MIN_SEC,
                max: DURATION_MAX_SEC,
                step: 10,
              },
            }}
            helperText={`Every run auto-stops at expiry — max ${String(DURATION_MAX_SEC)} s.`}
            sx={{ maxWidth: 280 }}
          />
          {running ? (
            <Button
              variant="outlined"
              color="error"
              startIcon={<StopIcon />}
              onClick={onStop}
              disabled={busy}
            >
              {busy ? 'Stopping…' : `Stop the ${sourceName}`}
            </Button>
          ) : (
            <Button
              variant="contained"
              startIcon={<PlayArrowIcon />}
              onClick={onStart}
              disabled={busy || !device.configured}
            >
              {busy ? 'Starting…' : `Start the ${sourceName}`}
            </Button>
          )}
        </Stack>
      </CardContent>
    </Card>
  );
};
