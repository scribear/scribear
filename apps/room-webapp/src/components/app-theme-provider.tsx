import CssBaseline from '@mui/material/CssBaseline';

import {
  selectAccentColor,
  selectBackgroundColor,
  selectTranscriptionColor,
} from '@scribear/theme-customization-store';
import { CustomThemeProvider } from '@scribear/theme-customization-ui';

import { useAppSelector } from '#src/store/use-redux';

/**
 * Props for {@link AppThemeProvider}.
 */
interface AppThemeProviderProps {
  children: React.ReactNode;
}

/**
 * Applies the Redux-driven MUI theme.
 */
export const AppThemeProvider = ({ children }: AppThemeProviderProps) => {
  const backgroundColor = useAppSelector(selectBackgroundColor);
  const accentColor = useAppSelector(selectAccentColor);
  const transcriptionColor = useAppSelector(selectTranscriptionColor);

  return (
    <CustomThemeProvider
      backgroundColor={backgroundColor}
      accentColor={accentColor}
      transcriptionColor={transcriptionColor}
    >
      <CssBaseline />
      {children}
    </CustomThemeProvider>
  );
};
