import type { ReactNode } from 'react';

import { ThemeProvider, createTheme } from '@mui/material/styles';

import { render } from '@testing-library/react';

// A theme providing the custom `transcriptionColor` palette entry the caption
// components read; without it `color="transcriptionColor"` throws looking up
// `palette.transcriptionColor.main`.
const testTheme = createTheme({
  palette: { transcriptionColor: { main: '#ffff00' } },
});

/** Renders translation UI inside the MUI theme it depends on. */
export function renderWithProviders(ui: ReactNode) {
  return render(<ThemeProvider theme={testTheme}>{ui}</ThemeProvider>);
}
