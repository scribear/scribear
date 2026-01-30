export interface ThemeColors {
  backgroundColor: string;
  accentColor: string;
  transcriptionColor: string;
}

export interface PresetThemeConfig extends ThemeColors {
  id: string;
  name: string;
}
