/**
 * Root of kiosk mode
 *
 * Flow:
 *   1. User enters an audio source secret and optionally tweaks transcription config
 *   2. App creates a session (session manager), room (node-server), and source token
 *   3. Audio from the browser microphone is streamed via WebSocket to the node-server
 *   4. A join code is displayed so students (clients) can connect
 */
import { useCallback, useMemo, useState } from 'react';

import MicIcon from '@mui/icons-material/Mic';
import MicOffIcon from '@mui/icons-material/MicOff';
import StopIcon from '@mui/icons-material/Stop';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';

import {
  type AudioSourceStatus,
  useAudioSource,
} from '@/core/audio-streaming/use-audio-source';
import {
  createRoom,
  createSession,
  createToken,
} from '@/core/session/session-api';

// ── Types ─────────────────────────────────────────────────

interface SessionInfo {
  sessionId: string;
  joinCode: string;
  token: string;
}

// ── Status helpers ────────────────────────────────────────

const STATUS_LABELS: Record<AudioSourceStatus, string> = {
  idle: 'Idle',
  connecting: 'Connecting…',
  streaming: 'Streaming audio',
  error: 'Error',
  disconnected: 'Disconnected',
};

const STATUS_COLORS: Record<AudioSourceStatus, 'default' | 'primary' | 'success' | 'error' | 'warning'> = {
  idle: 'default',
  connecting: 'primary',
  streaming: 'success',
  error: 'error',
  disconnected: 'warning',
};

// ── Component ─────────────────────────────────────────────

const KioskRoot = () => {
  // Setup form state
  const [secret, setSecret] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [setupError, setSetupError] = useState<string | null>(null);

  // Active session state
  const [session, setSession] = useState<SessionInfo | null>(null);

  // Memoize options so the hook reference is stable
  const audioOptions = useMemo(
    () =>
      session
        ? {
            sessionId: session.sessionId,
            token: session.token,
            sampleRate: 16000,
            numChannels: 1,
          }
        : null,
    [session],
  );

  const { status, error: streamError, disconnect } = useAudioSource(audioOptions);

  // ── Create session + room + token ──

  const handleStart = useCallback(async () => {
    if (secret.length < 16) {
      setSetupError('Audio source secret must be at least 16 characters');
      return;
    }

    setIsCreating(true);
    setSetupError(null);

    try {
      // 1. Create session on session manager
      const sessionRes = await createSession(secret);

      // 2. Create room on node-server with transcription config
      await createRoom(sessionRes.sessionId, {
        providerKey: 'whisper',
        useSsl: false,
        sampleRate: 16000,
        numChannels: 1,
      });

      // 3. Get source token
      const tokenRes = await createToken({
        sessionId: sessionRes.sessionId,
        audioSourceSecret: secret,
        scope: 'source',
      });

      setSession({
        sessionId: sessionRes.sessionId,
        joinCode: sessionRes.joinCode ?? '',
        token: tokenRes.token,
      });
    } catch (err) {
      setSetupError(err instanceof Error ? err.message : 'Failed to create session');
    } finally {
      setIsCreating(false);
    }
  }, [secret]);

  // ── Stop session ──

  const handleStop = useCallback(() => {
    disconnect();
    setSession(null);
  }, [disconnect]);

  // ── Render: Setup form ──

  if (!session) {
    return (
      <Box
        sx={{
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          height: '100vh',
          width: '100vw',
          p: 2,
        }}
      >
        <Paper sx={{ p: 4, maxWidth: 480, width: '100%' }}>
          <Typography variant="h5" gutterBottom>
            Kiosk Mode
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
            Start a transcription session. Students can join using the code
            displayed after setup.
          </Typography>

          <Stack spacing={2}>
            <TextField
              label="Audio Source Secret"
              type="password"
              fullWidth
              value={secret}
              onChange={(e) => {
                setSecret(e.target.value);
              }}
              helperText="Minimum 16 characters. Used to authenticate this kiosk."
              disabled={isCreating}
            />

            {setupError && <Alert severity="error">{setupError}</Alert>}

            <Button
              variant="contained"
              size="large"
              startIcon={
                isCreating ? <CircularProgress size={20} /> : <MicIcon />
              }
              disabled={isCreating || secret.length < 16}
              onClick={() => {
                void handleStart();
              }}
            >
              {isCreating ? 'Starting…' : 'Start Session'}
            </Button>
          </Stack>
        </Paper>
      </Box>
    );
  }

  // ── Render: Active session ──

  return (
    <Box
      sx={{
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        flexDirection: 'column',
        height: '100vh',
        width: '100vw',
        p: 2,
        gap: 3,
      }}
    >
      {/* Join code card */}
      <Paper sx={{ p: 4, textAlign: 'center', maxWidth: 480, width: '100%' }}>
        <Typography variant="overline" color="text.secondary">
          Join Code
        </Typography>
        <Typography
          variant="h2"
          fontWeight={700}
          sx={{ letterSpacing: '0.15em', my: 1 }}
        >
          {session.joinCode}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Share this code with students so they can connect in Client mode.
        </Typography>
      </Paper>

      {/* Status card */}
      <Paper sx={{ p: 3, maxWidth: 480, width: '100%' }}>
        <Stack spacing={2}>
          <Stack direction="row" justifyContent="space-between" alignItems="center">
            <Typography variant="subtitle1">Status</Typography>
            <Chip
              label={STATUS_LABELS[status]}
              color={STATUS_COLORS[status]}
              icon={
                status === 'streaming' ? (
                  <MicIcon />
                ) : (
                  <MicOffIcon />
                )
              }
              size="small"
            />
          </Stack>

          {streamError && <Alert severity="error">{streamError}</Alert>}

          <Typography variant="body2" color="text.secondary">
            Session: {session.sessionId.substring(0, 20)}…
          </Typography>

          <Button
            variant="outlined"
            color="error"
            startIcon={<StopIcon />}
            onClick={handleStop}
          >
            Stop Session
          </Button>
        </Stack>
      </Paper>
    </Box>
  );
};

export default KioskRoot;
