import type { ThemeOptions } from '@mui/material/styles';
import { createTheme } from '@mui/material/styles';

/**
 * Default MUI theme for the admin webapp placeholder. Uses a plain MUI
 * palette since no shared theme-customization store is wired up yet.
 */
export const BASE_THEME: ThemeOptions = createTheme({
  palette: {
    background: {
      default: '#f5f5f5',
      paper: '#ffffff',
    },
    primary: {
      main: '#1976d2',
    },
  },
});
