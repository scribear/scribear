import type { ThemeOptions } from '@mui/material/styles';
import { createTheme } from '@mui/material/styles';

import {
  BASE_ACCENT_COLOR,
  BASE_BACKGROUND_COLOR,
  BASE_TRANSCRIPTION_COLOR,
} from '@scribear/theme-customization-store';

const BASE_PAPER_COLOR = '#ffffff';

/**
 * Default MUI theme for the client webapp. Sets the base palette colours for
 * the background, primary accent, and transcription text using the shared
 * theme-store constants.
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
