/**
 * Defines the base theme of the application
 */
import type { ThemeOptions } from '@mui/material/styles';
import { createTheme } from '@mui/material/styles';

export const BASE_BACKGROUND_COLOR = '#000000';
export const BASE_PAPER_COLOR = '#ffffff';
export const BASE_ACCENT_COLOR = '#8b0000';
export const BASE_TRANSCRIPTION_COLOR = '#ffff00';

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
