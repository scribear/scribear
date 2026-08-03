import { useMemo } from 'react';

import { ThemeProvider, createTheme } from '@mui/material/styles';

import { isLightColor, readableTextColor } from '#src/utils/color-contrast.js';

/**
 * Props for {@link CustomThemeProvider}.
 */
interface CustomThemeProviderProps {
  // The application background color, as a CSS color string. Maps to palette.background.default in the MUI theme.
  backgroundColor: string;
  // The accent/primary color for interactive elements, as a CSS color string. Maps to palette.primary.main in the MUI theme.
  accentColor: string;
  // The color used to render transcription text, as a CSS color string. Maps to palette.transcriptionColor.main in the MUI theme.
  transcriptionColor: string;
  // The React subtree that will consume the generated MUI theme via context.
  children: React.ReactNode;
}

/**
 * Wraps children in an MUI `ThemeProvider` whose palette is derived from
 * the provided theme colors.
 *
 * The theme is memoized and only recomputed when `backgroundColor`,
 * `accentColor`, or `transcriptionColor` change.
 */
export const CustomThemeProvider = ({
  backgroundColor,
  accentColor,
  transcriptionColor,
  children,
}: CustomThemeProviderProps) => {
  const theme = useMemo(() => {
    // Derive palette mode + default text color from the chosen background's
    // luminance. Without this MUI keeps its light-mode near-black default text,
    // so any default-colored Typography/icon is invisible on a dark background
    // (only the explicitly-colored transcription text was safe before). SC 1.4.3
    const mode = isLightColor(backgroundColor) ? 'light' : 'dark';
    return createTheme({
      palette: {
        mode,
        background: {
          default: backgroundColor,
        },
        text: {
          primary: readableTextColor(backgroundColor),
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
