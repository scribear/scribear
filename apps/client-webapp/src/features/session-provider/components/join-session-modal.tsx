import { type SyntheticEvent, useState } from 'react';

import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import TextField from '@mui/material/TextField';

import { useAppDispatch, useAppSelector } from '#src/store/use-redux';

import { ClientSessionServiceStatus } from '../services/client-session-service-status';
import { selectClientSessionServiceStatus } from '../stores/client-session-service-slice';
import { joinSession } from '../stores/client-session-service-slice';

/**
 * Modal dialog that prompts the user to enter a join code to connect
 * to an active transcription session. Shown when no session is active.
 */
export const JoinSessionModal = () => {
  const dispatch = useAppDispatch();
  const status = useAppSelector(selectClientSessionServiceStatus);
  const [joinCode, setJoinCode] = useState('');

  const isOpen =
    status === ClientSessionServiceStatus.IDLE ||
    status === ClientSessionServiceStatus.JOIN_ERROR;
  const isError = status === ClientSessionServiceStatus.JOIN_ERROR;

  const handleSubmit = (e: SyntheticEvent) => {
    e.preventDefault();
    const trimmed = joinCode.trim();
    if (trimmed.length === 0) return;
    void dispatch(joinSession(trimmed));
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
            error={isError}
            slotProps={{ htmlInput: { maxLength: 16 } }}
            sx={{ mb: 2, fontFamily: 'monospace' }}
          />
          {isError && (
            <Alert severity="error" sx={{ mb: 2 }}>
              Invalid join code. Please try again.
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
