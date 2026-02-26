/**
 * Groups all application providers together for maintainability
 */
import { Suspense } from 'react';

import CssBaseline from '@mui/material/CssBaseline';
import { ThemeProvider } from '@mui/material/styles';

// MUI fonts
import '@fontsource/roboto/300.css';
import '@fontsource/roboto/400.css';
import '@fontsource/roboto/500.css';
import '@fontsource/roboto/700.css';
import { ErrorBoundary } from 'react-error-boundary';
import { Provider } from 'react-redux';

import { RehydrateGate } from '#src/components/rehydrate-gate';
import { MainErrorFallback } from '#src/components/ui/main-error-fallback';
import { PageLoadSpinner } from '#src/components/ui/page-load-spinner';
import { BASE_THEME } from '#src/config/base-theme';
import { MicrophoneServiceProvider } from '#src/core/microphone/contexts/microphone-service-provider';
import { CustomThemeProvider } from '#src/features/theme-customization/contexts/custom-theme/custom-theme-provider';
import { TranscriptionDisplayProvider } from '#src/features/transcription-display/contexts/transcription-display/transcription-display-provider';
import { store } from '#src/stores/store';

interface AppProviderProps {
  children: React.ReactNode;
}

export const AppProvider = ({ children }: AppProviderProps) => {
  return (
    <ThemeProvider theme={BASE_THEME}>
      <Suspense fallback={<PageLoadSpinner />}>
        <ErrorBoundary FallbackComponent={MainErrorFallback}>
          <Provider store={store}>
            <RehydrateGate>
              <CustomThemeProvider>
                <CssBaseline />
                <TranscriptionDisplayProvider>
                  <MicrophoneServiceProvider>
                    {children}
                  </MicrophoneServiceProvider>
                </TranscriptionDisplayProvider>
              </CustomThemeProvider>
            </RehydrateGate>
          </Provider>
        </ErrorBoundary>
      </Suspense>
    </ThemeProvider>
  );
};
