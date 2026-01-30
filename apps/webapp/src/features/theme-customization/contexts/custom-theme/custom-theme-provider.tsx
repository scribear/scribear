/**
 * Provides MUI theme for custom selected theme
 */
import { useMemo } from 'react';

import { ThemeProvider, createTheme } from '@mui/material/styles';

import { useAppSelector } from '@/stores/use-redux';

import {
  selectAccentColor,
  selectBackgroundColor,
  selectTranscriptionColor,
} from '../../stores/theme-preferences-slice';

interface CustomThemeProviderProps {
  children: React.ReactNode;
}

export const CustomThemeProvider = ({ children }: CustomThemeProviderProps) => {
  const backgroundColor = useAppSelector(selectBackgroundColor);
  const transcriptionColor = useAppSelector(selectTranscriptionColor);
  const accentColor = useAppSelector(selectAccentColor);

  const theme = useMemo(() => {
    return createTheme({
      palette: {
        background: {
          default: backgroundColor,
        },
        primary: {
          main: accentColor,
        },
        transcriptionColor: {
          main: transcriptionColor,
        },
      },
    });
  }, [backgroundColor, transcriptionColor, accentColor]);

  return <ThemeProvider theme={theme}>{children}</ThemeProvider>;
};
