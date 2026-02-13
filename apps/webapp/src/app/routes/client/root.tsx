/**
 * Root of client mode
 *
 * Flow:
 *   1. User enters a join code (provided by the kiosk)
 *   2. App gets a sink token from the session manager
 *   3. Connects WebSocket to node-server /transcription/:sessionId
 *   4. Displays live transcripts using existing transcription display components
 */
import { useCallback, useMemo, useState } from 'react';

import LinkIcon from '@mui/icons-material/Link';
import LinkOffIcon from '@mui/icons-material/LinkOff';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';

import { AppLayout } from '@/components/app-layout';
import { createToken } from '@/core/session/session-api';
import {
  type TranscriptReceiverStatus,
  useTranscriptReceiver,
} from '@/core/transcript-receiver/use-transcript-receiver';
import { clearTranscription } from '@/core/transcription-content/store/transcription-content-slice';
import { ThemeCustomizationMenu } from '@/features/theme-customization/components/theme-customization-menu';
import { TranscriptionDisplayContainer } from '@/features/transcription-display/components/transcription-display-container';
import { TranscriptionDisplayPreferencesMenu } from '@/features/transcription-display/components/transcription-display-preferences-menu';
import { useAppDispatch } from '@/stores/use-redux';

// ── Types ─────────────────────────────────────────────────

interface ConnectionInfo {
  sessionId: string;
  token: string;
}

// ── Status helpers ────────────────────────────────────────

const STATUS_LABELS: Record<TranscriptReceiverStatus, string> = {
  idle: 'Idle',
  connecting: 'Connecting…',
  connected: 'Connected — receiving transcripts',
  error: 'Error',
  disconnected: 'Disconnected',
};

const STATUS_COLORS: Record<TranscriptReceiverStatus, 'default' | 'primary' | 'success' | 'error' | 'warning'> = {
  idle: 'default',
  connecting: 'primary',
  connected: 'success',
  error: 'error',
  disconnected: 'warning',
};

// ── Component ─────────────────────────────────────────────

const ClientRoot = () => {
  const dispatch = useAppDispatch();

  // Join form state
  const [joinCode, setJoinCode] = useState('');
  const [isJoining, setIsJoining] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);

  // Active connection state
  const [connection, setConnection] = useState<ConnectionInfo | null>(null);

  // Memoize so hook reference is stable
  const receiverOptions = useMemo(
    () =>
      connection
        ? { sessionId: connection.sessionId, token: connection.token }
        : null,
    [connection],
  );

  const {
    status,
    error: wsError,
    disconnect,
  } = useTranscriptReceiver(receiverOptions);

  // ── Join session ──

  const handleJoin = useCallback(async () => {
    const trimmed = joinCode.trim();
    if (!trimmed) {
      setJoinError('Please enter a join code');
      return;
    }

    setIsJoining(true);
    setJoinError(null);

    try {
      // Clear previous transcription content
      dispatch(clearTranscription());

      const tokenRes = await createToken({
        joinCode: trimmed,
        scope: 'sink',
      });

      setConnection({
        sessionId: tokenRes.sessionId,
        token: tokenRes.token,
      });
    } catch (err) {
      setJoinError(
        err instanceof Error ? err.message : 'Failed to join session',
      );
    } finally {
      setIsJoining(false);
    }
  }, [joinCode, dispatch]);

  // ── Disconnect ──

  const handleDisconnect = useCallback(() => {
    disconnect();
    setConnection(null);
  }, [disconnect]);

  // ── Render: Join form ──

  if (!connection) {
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
        <Paper sx={{ p: 4, maxWidth: 420, width: '100%' }}>
          <Typography variant="h5" gutterBottom>
            Client Mode
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
            Enter the join code from the kiosk to receive live transcriptions.
          </Typography>

          <Stack spacing={2}>
            <TextField
              label="Join Code"
              fullWidth
              value={joinCode}
              onChange={(e) => {
                setJoinCode(e.target.value.toUpperCase());
              }}
              placeholder="e.g. ABC123"
              disabled={isJoining}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleJoin();
              }}
              slotProps={{ htmlInput: { style: { letterSpacing: '0.15em', fontSize: '1.25rem' } } }}
            />

            {joinError && <Alert severity="error">{joinError}</Alert>}

            <Button
              variant="contained"
              size="large"
              startIcon={
                isJoining ? <CircularProgress size={20} /> : <LinkIcon />
              }
              disabled={isJoining || !joinCode.trim()}
              onClick={() => {
                void handleJoin();
              }}
            >
              {isJoining ? 'Joining…' : 'Join Session'}
            </Button>
          </Stack>
        </Paper>
      </Box>
    );
  }

  // ── Render: Connected — transcript display ──

  const DrawerMenus = (
    <>
      <ThemeCustomizationMenu />
      <TranscriptionDisplayPreferencesMenu />
    </>
  );

  const ConnectionStatus = (
    <Chip
      label={STATUS_LABELS[status]}
      color={STATUS_COLORS[status]}
      size="small"
      icon={status === 'connected' ? <LinkIcon /> : <LinkOffIcon />}
    />
  );

  const HeaderButtons = [
    ConnectionStatus,
    <Button
      key="disconnect"
      variant="outlined"
      color="error"
      size="small"
      startIcon={<LinkOffIcon />}
      onClick={handleDisconnect}
      sx={{ ml: 1 }}
    >
      Leave
    </Button>,
  ];

  return (
    <AppLayout
      drawerContent={DrawerMenus}
      headerButtons={HeaderButtons}
      headerBreakpoint="md"
    >
      {wsError && (
        <Alert severity="error" sx={{ m: 2 }}>
          {wsError}
        </Alert>
      )}
      <TranscriptionDisplayContainer />
    </AppLayout>
  );
};

export default ClientRoot;
