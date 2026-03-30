/**
 * The three color values that define a complete application theme.
 */
export interface ThemeColors {
  backgroundColor: string;
  accentColor: string;
  transcriptionColor: string;
}

/**
 * A named, pre-configured theme with a unique identifier.
 * Extends {@link ThemeColors} with display metadata for use in a theme picker.
 */
export interface PresetThemeConfig extends ThemeColors {
  id: string;
  name: string;
}
