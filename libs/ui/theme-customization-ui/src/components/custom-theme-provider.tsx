import { useMemo } from 'react';

import { ThemeProvider, createTheme } from '@mui/material/styles';

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
