import { type SyntheticEvent, useId, useState } from 'react';

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
  JoinNotice,
} from '../services/client-session-service-status';
import {
  joinSession,
  selectJoinError,
  selectJoinNotice,
  selectLifecycle,
} from '../stores/client-session-service-slice';

/**
 * Why the dialog is open, when nothing failed. Rendered above the join field
 * as `info`: expected, no fault, nothing red. Before this existed a session
 * ending normally simply made the captions disappear behind a blank join
 * prompt, which is exactly what a crash looks like.
 */
const JOIN_NOTICE_MESSAGES: Record<JoinNotice, string> = {
  [JoinNotice.SESSION_ENDED]:
    'This session has ended. Enter a new join code to watch another session.',
};

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
  const joinNotice = useAppSelector(selectJoinNotice);
  const [joinCode, setJoinCode] = useState('');
  const titleId = useId();
  const errorId = useId();
  const noticeId = useId();

  const isOpen = lifecycle === ClientLifecycle.IDLE;

  const handleSubmit = (e: SyntheticEvent) => {
    e.preventDefault();
    const trimmed = joinCode.trim();
    if (trimmed.length === 0) return;
    dispatch(joinSession(trimmed));
  };

  return (
    <Dialog
      open={isOpen}
      aria-labelledby={titleId}
      // Describes the dialog, so the reason it appeared is announced with the
      // title on open rather than only if the user happens to navigate to it.
      aria-describedby={joinNotice !== null ? noticeId : undefined}
    >
      <DialogTitle id={titleId}>Join Session</DialogTitle>
      <DialogContent>
        {joinNotice !== null && (
          <Alert id={noticeId} severity="info" sx={{ mt: 1 }}>
            {JOIN_NOTICE_MESSAGES[joinNotice]}
          </Alert>
        )}
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
            slotProps={{
              htmlInput: {
                maxLength: 16,
                style: { fontFamily: 'monospace' },
                'aria-describedby': joinError !== null ? errorId : undefined,
              },
            }}
            sx={{ mb: 2 }}
          />
          {joinError !== null && (
            // role="alert" (MUI Alert default) announces it; the id ties it to
            // the field for follow-up navigation. SC 4.1.3, 3.3.1
            <Alert id={errorId} severity="error" sx={{ mb: 2 }}>
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
