import { useCallback, useMemo, useState } from 'react';

import CloseIcon from '@mui/icons-material/Close';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import Snackbar from '@mui/material/Snackbar';

import {
  type ToastAction,
  type ToastApi,
  ToastContext,
  type ToastSeverity,
} from './toast-context';

interface ToastState {
  open: boolean;
  message: string;
  severity: ToastSeverity;
  action: ToastAction | undefined;
}

/**
 * Snackbar host + `useToast()` provider. One toast at a time; auto-hides.
 * A success toast may carry an action (e.g. "Undo") — it disappears with
 * the toast itself, either on auto-hide or once a later toast replaces it,
 * so there's no separate state to track for "is the action still available".
 */
export const ToastProvider = ({ children }: React.PropsWithChildren) => {
  const [state, setState] = useState<ToastState>({
    open: false,
    message: '',
    severity: 'info',
    action: undefined,
  });

  const show = useCallback(
    (message: string, severity: ToastSeverity, action?: ToastAction) => {
      setState({ open: true, message, severity, action });
    },
    [],
  );

  const api = useMemo<ToastApi>(
    () => ({
      showSuccess: (m, action) => {
        show(m, 'success', action);
      },
      showError: (m) => {
        show(m, 'error');
      },
      showInfo: (m) => {
        show(m, 'info');
      },
    }),
    [show],
  );

  const handleClose = () => {
    setState((s) => ({ ...s, open: false }));
  };

  return (
    <ToastContext value={api}>
      {children}
      <Snackbar
        open={state.open}
        autoHideDuration={5000}
        onClose={handleClose}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
      >
        <Alert
          severity={state.severity}
          variant="filled"
          onClose={handleClose}
          action={
            state.action && (
              <>
                <Button
                  color="inherit"
                  size="small"
                  onClick={() => {
                    state.action?.onClick();
                    handleClose();
                  }}
                >
                  {state.action.label}
                </Button>
                <IconButton
                  color="inherit"
                  size="small"
                  onClick={handleClose}
                  aria-label="Close"
                >
                  <CloseIcon fontSize="small" />
                </IconButton>
              </>
            )
          }
          sx={{
            width: '100%',
            // MUI's default filled-variant text color (white) on these two
            // severities' `main` falls below the WCAG AA 4.5:1 minimum for
            // normal text (info ~3.86:1, warning ~3.11:1) — override just
            // enough to clear it without touching the shared theme palette
            // used elsewhere (buttons, chips, standard-variant Alerts).
            ...(state.severity === 'info' && { bgcolor: 'info.dark' }),
            ...(state.severity === 'warning' && {
              color: 'rgba(0, 0, 0, 0.87)',
            }),
          }}
        >
          {state.message}
        </Alert>
      </Snackbar>
    </ToastContext>
  );
};
