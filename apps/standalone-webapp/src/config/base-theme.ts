import type { ThemeOptions } from '@mui/material/styles';
import { createTheme } from '@mui/material/styles';

import {
  BASE_ACCENT_COLOR,
  BASE_BACKGROUND_COLOR,
  BASE_TRANSCRIPTION_COLOR,
} from '@scribear/theme-customization-store';

// White paper surface color used in the base MUI theme.
const BASE_PAPER_COLOR = '#ffffff';

/**
 * The baseline MUI theme for the standalone webapp. Sets the default
 * background, paper, primary accent, and custom transcription text colors
 * derived from the shared theme-store defaults.
 */
export const BASE_THEME: ThemeOptions = createTheme({
  palette: {
    background: {
      default: BASE_BACKGROUND_COLOR,
      paper: BASE_PAPER_COLOR,
    },
    primary: {
      main: BASE_ACCENT_COLOR,
    },
    transcriptionColor: {
      main: BASE_TRANSCRIPTION_COLOR,
    },
  },
});
