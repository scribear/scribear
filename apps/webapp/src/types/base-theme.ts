/**
 * Defines typings for custom additions to MUI theme
 */

declare module '@mui/material/styles' {
  interface Palette {
    transcriptionColor: PaletteOptions['primary'];
  }
  interface PaletteOptions {
    transcriptionColor?: PaletteOptions['primary'];
  }
}

declare module '@mui/material/Typography' {
  interface TypographyPropsColorOverrides {
    transcriptionColor: true;
  }
}

declare module '@mui/material/Button' {
  interface ButtonPropsColorOverrides {
    transcriptionColor: true;
  }
}

declare module '@mui/material/IconButton' {
  interface IconButtonPropsColorOverrides {
    transcriptionColor: true;
  }
}
