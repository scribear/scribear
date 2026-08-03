import { createContext, use } from 'react';

export type ToastSeverity = 'success' | 'error' | 'info' | 'warning';

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastApi {
  showSuccess: (message: string, action?: ToastAction) => void;
  showError: (message: string) => void;
  showInfo: (message: string) => void;
  showWarning: (message: string) => void;
  /**
   * Renders a failed admin API call at the severity its cause deserves.
   * Prefer this over hand-rolling `showError(...)` from an error's message:
   * admin-server rate
   * limits every route, and a 429 is transient — showing it in the same red
   * toast as a real failure tells the operator to act when the only action is
   * to wait. See `errorMessage`/`errorSeverity` in `./api-error`.
   */
  showApiError: (err: unknown, fallback: string) => void;
}

export const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const ctx = use(ToastContext);
  if (!ctx) throw new Error('useToast must be used within a ToastProvider.');
  return ctx;
}
