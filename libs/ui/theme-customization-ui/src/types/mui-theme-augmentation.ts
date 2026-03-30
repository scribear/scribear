/**
 * MUI theme module augmentations that introduce a `transcriptionColor` palette slot.
 *
 * Extending `Palette` and `PaletteOptions` registers the custom color so it
 * can be passed to `createTheme` and used as the `color` prop on `Typography`,
 * `Button`, and `IconButton` components without TypeScript errors.
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

export {};
