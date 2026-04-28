import { type SyntheticEvent, useState } from 'react';

import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import TextField from '@mui/material/TextField';

import { useAppDispatch, useAppSelector } from '#src/store/use-redux';

import {
  ClientLifecycle,
  JoinError,
} from '../services/client-session-service-status';
import {
  joinSession,
  selectJoinError,
  selectLifecycle,
} from '../stores/client-session-service-slice';

const JOIN_ERROR_MESSAGES: Record<JoinError, string> = {
  [JoinError.NETWORK_ERROR]:
    'Network error. Check your connection and try again.',
  [JoinError.JOIN_CODE_NOT_FOUND]: 'Invalid join code. Please try again.',
  [JoinError.JOIN_CODE_EXPIRED]:
    'This join code has expired. Ask for a new one.',
  [JoinError.SESSION_NOT_CURRENTLY_ACTIVE]:
    'The session is not currently active.',
  [JoinError.UNKNOWN]: 'Unable to join session. Please try again.',
};

/**
 * Modal dialog that prompts the user to enter a join code to connect to an
 * active transcription session. Open while the client is in `IDLE`; closes
 * automatically once the lifecycle reaches `ACTIVE`.
 */
export const JoinSessionModal = () => {
  const dispatch = useAppDispatch();
  const lifecycle = useAppSelector(selectLifecycle);
  const joinError = useAppSelector(selectJoinError);
  const [joinCode, setJoinCode] = useState('');

  const isOpen = lifecycle === ClientLifecycle.IDLE;

  const handleSubmit = (e: SyntheticEvent) => {
    e.preventDefault();
    const trimmed = joinCode.trim();
    if (trimmed.length === 0) return;
    dispatch(joinSession(trimmed));
  };

  return (
    <Dialog open={isOpen} disableEscapeKeyDown>
      <DialogTitle>Join Session</DialogTitle>
      <DialogContent>
        <Box component="form" onSubmit={handleSubmit} sx={{ pt: 1 }}>
          <TextField
            autoFocus
            fullWidth
            label="Join Code"
            value={joinCode}
            onChange={(e) => {
              setJoinCode(e.target.value.toUpperCase());
            }}
            error={joinError !== null}
            slotProps={{ htmlInput: { maxLength: 16 } }}
            sx={{ mb: 2, fontFamily: 'monospace' }}
          />
          {joinError !== null && (
            <Alert severity="error" sx={{ mb: 2 }}>
              {JOIN_ERROR_MESSAGES[joinError]}
            </Alert>
          )}
          <Button
            type="submit"
            variant="contained"
            fullWidth
            disabled={joinCode.trim().length === 0}
          >
            Join
          </Button>
        </Box>
      </DialogContent>
    </Dialog>
  );
};
