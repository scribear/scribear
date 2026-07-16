import { useCallback, useMemo, useState } from 'react';

import Alert from '@mui/material/Alert';
import Snackbar from '@mui/material/Snackbar';

import {
  type ToastApi,
  ToastContext,
  type ToastSeverity,
} from './toast-context';

interface ToastState {
  open: boolean;
  message: string;
  severity: ToastSeverity;
}

/**
 * Snackbar host + `useToast()` provider. One toast at a time; auto-hides.
 */
export const ToastProvider = ({ children }: React.PropsWithChildren) => {
  const [state, setState] = useState<ToastState>({
    open: false,
    message: '',
    severity: 'info',
  });

  const show = useCallback((message: string, severity: ToastSeverity) => {
    setState({ open: true, message, severity });
  }, []);

  const api = useMemo<ToastApi>(
    () => ({
      showSuccess: (m) => {
        show(m, 'success');
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
          sx={{ width: '100%' }}
        >
          {state.message}
        </Alert>
      </Snackbar>
    </ToastContext>
  );
};
