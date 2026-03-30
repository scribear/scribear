import FormatPaintIcon from '@mui/icons-material/FormatPaint';

import { DrawerMenuGroup } from '@scribear/core-ui';
import type { ThemeColors } from '@scribear/theme-customization-store';

import { AccentColorSelector } from './color-controls/accent-color-selector.js';
import { BackgroundColorSelector } from './color-controls/background-color-selector.js';
import { TranscriptionColorSelector } from './color-controls/transcription-color-selector.js';
import { PresetThemeSelector } from './preset-theme-selector.js';

/**
 * Props for {@link ThemeCustomizationMenu}.
 */
export interface ThemeCustomizationMenuProps {
  // The current background color of the application, as a CSS color string (e.g. "#1a1a2e").
  backgroundColor: string;
  // The current accent color used for interactive elements and highlights, as a CSS color string.
  accentColor: string;
  // The current color used to render transcription text, as a CSS color string.
  transcriptionColor: string;
  // Callback to update the background color. Receives the new CSS color string chosen by the user.
  setBackgroundColor: (value: string) => void;
  // Callback to update the accent color. Receives the new CSS color string chosen by the user.
  setAccentColor: (value: string) => void;
  // Callback to update the transcription text color. Receives the new CSS color string chosen by the user.
  setTranscriptionColor: (value: string) => void;
  // Callback invoked when the user selects a preset theme. Receives a ThemeColors object containing
  // all three color values (backgroundColor, accentColor, transcriptionColor) to apply at once.
  applyPresetTheme: (theme: ThemeColors) => void;
}

/**
 * Collapsible drawer menu group that houses all theme color controls.
 */
export const ThemeCustomizationMenu = ({
  backgroundColor,
  accentColor,
  transcriptionColor,
  setBackgroundColor,
  setAccentColor,
  setTranscriptionColor,
  applyPresetTheme,
}: ThemeCustomizationMenuProps) => {
  return (
    <DrawerMenuGroup summary="Theme Customization" icon={<FormatPaintIcon />}>
      <BackgroundColorSelector
        backgroundColor={backgroundColor}
        setBackgroundColor={setBackgroundColor}
      />
      <AccentColorSelector
        accentColor={accentColor}
        setAccentColor={setAccentColor}
      />
      <TranscriptionColorSelector
        transcriptionColor={transcriptionColor}
        setTranscriptionColor={setTranscriptionColor}
      />
      <PresetThemeSelector applyPresetTheme={applyPresetTheme} />
    </DrawerMenuGroup>
  );
};
