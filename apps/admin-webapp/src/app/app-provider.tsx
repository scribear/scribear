import CssBaseline from '@mui/material/CssBaseline';
import { ThemeProvider } from '@mui/material/styles';

import '@fontsource/roboto/300.css';
import '@fontsource/roboto/400.css';
import '@fontsource/roboto/500.css';
import '@fontsource/roboto/700.css';
import { ErrorBoundary } from 'react-error-boundary';
import { BrowserRouter } from 'react-router-dom';

import { MainErrorFallback } from '#src/components/main-error-fallback';
import { BASE_THEME } from '#src/config/base-theme';
import { AuthProvider } from '#src/features/auth/auth-provider';
import { SettingsProvider } from '#src/lib/settings-provider';
import { ToastProvider } from '#src/lib/toast-provider';

// Served under /admin/ in production; import.meta.env.BASE_URL is '/admin/'.
const BASENAME = import.meta.env.BASE_URL.replace(/\/$/, '') || '/';

/**
 * Top-level provider composition: MUI theme, error boundary, toast host,
 * router, and the auth session.
 */
export const AppProvider = ({ children }: React.PropsWithChildren) => {
  return (
    <ThemeProvider theme={BASE_THEME}>
      <CssBaseline />
      <ErrorBoundary FallbackComponent={MainErrorFallback}>
        <ToastProvider>
          <SettingsProvider>
            <BrowserRouter basename={BASENAME}>
              <AuthProvider>{children}</AuthProvider>
            </BrowserRouter>
          </SettingsProvider>
        </ToastProvider>
      </ErrorBoundary>
    </ThemeProvider>
  );
};
