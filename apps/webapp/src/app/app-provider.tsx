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

import { RehydrateGate } from '@/components/rehydrate-gate';
import { MainErrorFallback } from '@/components/ui/main-error-fallback';
import { PageLoadSpinner } from '@/components/ui/page-load-spinner';
import { BASE_THEME } from '@/config/base-theme';
import { MicrophoneServiceProvider } from '@/core/microphone/contexts/microphone-service-provider';
import { CustomThemeProvider } from '@/features/theme-customization/contexts/custom-theme/custom-theme-provider';
import { TranscriptionDisplayProvider } from '@/features/transcription-display/contexts/transcription-display/transcription-display-provider';
import { store } from '@/stores/store';
import { MicrophoneVisualizerOverlay } from '@/core/microphone/components/microphone-visualizers/visualizer-overlay';

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
                    <MicrophoneVisualizerOverlay />
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
