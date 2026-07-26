import LogoutIcon from '@mui/icons-material/Logout';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';

import { useAppDispatch, useAppSelector } from '#src/store/use-redux';

import { ClientLifecycle } from '../services/client-session-service-status';
import {
  leaveSession,
  selectLifecycle,
} from '../stores/client-session-service-slice';

/**
 * Header button that disconnects from the current session so the viewer can
 * join a different room.
 *
 * Renders nothing unless a session is actually joined: while the join dialog is
 * open there is nothing to leave, and a live "Leave" control behind a modal is
 * only reachable by keyboard users tabbing out of it.
 *
 * All of the work happens in the service, which tears down the socket, clears
 * the persisted identity so a reload does not resume the old session, and drops
 * to `IDLE`. The join dialog is bound to `IDLE`, so it reopens on its own, and
 * the middleware clears the transcript on any exit from `ACTIVE` - the next room
 * starts blank rather than inheriting the last one's captions.
 */
export const LeaveSessionButton = () => {
  const dispatch = useAppDispatch();
  const lifecycle = useAppSelector(selectLifecycle);

  if (lifecycle !== ClientLifecycle.ACTIVE) return null;

  return (
    <Tooltip title="Leave session">
      <IconButton
        color="inherit"
        aria-label="Leave session and join a different room"
        onClick={() => dispatch(leaveSession())}
      >
        <LogoutIcon />
      </IconButton>
    </Tooltip>
  );
};
