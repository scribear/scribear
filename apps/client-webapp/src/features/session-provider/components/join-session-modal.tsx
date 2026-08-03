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
  // Names the cause (the room, not this person), and gives a next action that
  // does not reproduce it: no immediate retry, and explicitly no new join
  // code. "Please try again." here was advice a whole lecture hall would take
  // simultaneously, producing the next round of 429s.
  [JoinError.RATE_LIMITED]:
    'Too many people are joining at once. Wait a minute, then try the same join code again — this clears on its own.',
  // Either no structured error body at all (session-manager failed partway
  // through a response it had already started, or the connection dropped
  // mid-body), or nginx's own 502/503/504 for a session-manager it couldn't
  // reach - see `JoinError.SERVICE_UNREACHABLE`'s doc. Names the service, not
  // the code, as the suspect.
  [JoinError.SERVICE_UNREACHABLE]:
    'Could not reach the session service. This is not a problem with your join code — try again in a moment.',
  // A body that parsed as JSON but didn't match what this client expects, or
  // some other status this build's schema doesn't recognize - session-manager
  // answered, just not with anything this build understands. Usually a
  // partial deploy; a reload can pick up a matching build.
  [JoinError.VERSION_MISMATCH]:
    'This app may be out of date with the session service. Reload the page and try again.',
  [JoinError.UNKNOWN]: 'Unable to join session. Please try again.',
};

/**
 * Severity per failure, following the convention `info` = expected, no action;
 * `warning` = degraded/transient, no action yet; `error` = terminal, action
 * required. Everything here is a genuine failure to join except the rate
 * limit, which is a self-clearing condition the user did not cause and cannot
 * fix - painting the join field red for it says "your code is wrong" about a
 * code that is perfectly good.
 */
const JOIN_ERROR_SEVERITY: Record<JoinError, 'error' | 'warning'> = {
  [JoinError.NETWORK_ERROR]: 'error',
  [JoinError.JOIN_CODE_NOT_FOUND]: 'error',
  [JoinError.JOIN_CODE_EXPIRED]: 'error',
  [JoinError.SESSION_NOT_CURRENTLY_ACTIVE]: 'error',
  [JoinError.RATE_LIMITED]: 'warning',
  // Both name a next action (retry shortly / reload), same as NETWORK_ERROR,
  // so they follow its precedent rather than RATE_LIMITED's: this isn't a
  // self-clearing condition the whole room shares, so there's no reason to
  // withhold the "something's wrong" framing the way RATE_LIMITED does.
  [JoinError.SERVICE_UNREACHABLE]: 'error',
  [JoinError.VERSION_MISMATCH]: 'error',
  [JoinError.UNKNOWN]: 'error',
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
  const joinErrorSeverity =
    joinError === null ? null : JOIN_ERROR_SEVERITY[joinError];

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
            // Only a failure that says something is wrong with what was typed
            // marks the field invalid; a rate limit does not.
            error={joinErrorSeverity === 'error'}
            slotProps={{
              htmlInput: {
                maxLength: 16,
                style: { fontFamily: 'monospace' },
                'aria-describedby': joinError !== null ? errorId : undefined,
              },
            }}
            sx={{ mb: 2 }}
          />
          {joinError !== null && joinErrorSeverity !== null && (
            // role="alert" (MUI Alert default) announces it; the id ties it to
            // the field for follow-up navigation. SC 4.1.3, 3.3.1
            <Alert id={errorId} severity={joinErrorSeverity} sx={{ mb: 2 }}>
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
