import React, { Suspense } from 'react';

import { ThemeProvider } from '@mui/material/styles';

import '@fontsource/roboto/300.css';
import '@fontsource/roboto/400.css';
import '@fontsource/roboto/500.css';
import '@fontsource/roboto/700.css';
import { ErrorBoundary } from 'react-error-boundary';
import { Provider } from 'react-redux';

import { MainErrorFallback, PageLoadSpinner } from '@scribear/core-ui';
import { MicrophoneService } from '@scribear/microphone-store';
import { MicrophoneServiceProvider } from '@scribear/microphone-ui';
import { TranscriptionDisplayProvider } from '@scribear/transcription-display-ui';

import { AppThemeProvider } from '#src/components/app-theme-provider';
import { RehydrateGate } from '#src/components/rehydrate-gate.js';
import { BASE_THEME } from '#src/config/base-theme';
import { UrlConfigErrorModal } from '#src/features/url-config/components/url-config-error-modal';
import { createAppStore } from '#src/store/store';

// Module-scoped singletons, not exported, so they can only be accessed via
// the React providers below.
const microphoneService = new MicrophoneService();
const store = createAppStore(microphoneService);

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    microphoneService.deactivateMicrophone();
    microphoneService.removeAllListeners();
  });
}

/**
 * Composes all application-level providers for the standalone webapp: Redux
 * store, MUI theme, error boundary, Suspense, rehydration gate, and custom theme.
 */
export const AppProvider = ({ children }: React.PropsWithChildren) => {
  return (
    <ThemeProvider theme={BASE_THEME}>
      <Suspense fallback={<PageLoadSpinner />}>
        <ErrorBoundary FallbackComponent={MainErrorFallback}>
          <Provider store={store}>
            <RehydrateGate>
              <UrlConfigErrorModal />
              <MicrophoneServiceProvider service={microphoneService}>
                <AppThemeProvider>
                  <TranscriptionDisplayProvider>
                    {children}
                  </TranscriptionDisplayProvider>
                </AppThemeProvider>
              </MicrophoneServiceProvider>
            </RehydrateGate>
          </Provider>
        </ErrorBoundary>
      </Suspense>
    </ThemeProvider>
  );
};
