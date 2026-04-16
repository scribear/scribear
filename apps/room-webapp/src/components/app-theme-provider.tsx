import CssBaseline from '@mui/material/CssBaseline';
import GlobalStyles from '@mui/material/GlobalStyles';

import {
  selectAccentColor,
  selectBackgroundColor,
  selectTranscriptionColor,
} from '@scribear/theme-customization-store';
import { CustomThemeProvider } from '@scribear/theme-customization-ui';

import { useAppSelector } from '#src/store/use-redux';

const ROOM_TEXT_PRIMARY = '#ffffff';
const ROOM_TEXT_SECONDARY = 'rgba(255, 255, 255, 0.78)';

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
      <GlobalStyles
        styles={{
          'html, body, #root': {
            color: ROOM_TEXT_PRIMARY,
          },
          '.MuiTypography-root:not(.MuiTypography-colorTranscriptionColor), .MuiListItemText-primary, .MuiListItemText-secondary, .MuiFormLabel-root, .MuiInputLabel-root, .MuiFormHelperText-root, .MuiInputBase-input, .MuiFormControlLabel-label, .MuiChip-label, .MuiTableCell-root': {
            color: `${ROOM_TEXT_PRIMARY} !important`,
          },
          '.MuiTypography-root.MuiTypography-colorTextSecondary:not(.MuiTypography-colorTranscriptionColor), .MuiListItemText-secondary, .MuiFormHelperText-root, .MuiInputBase-input::placeholder': {
            color: `${ROOM_TEXT_SECONDARY} !important`,
          },
          '.MuiInputBase-input::placeholder': {
            color: `${ROOM_TEXT_SECONDARY} !important`,
            opacity: 1,
          },
        }}
      />
      {children}
    </CustomThemeProvider>
  );
};
