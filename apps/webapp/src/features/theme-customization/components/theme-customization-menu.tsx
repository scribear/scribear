import FormatPaintIcon from '@mui/icons-material/FormatPaint';

import { DrawerMenuGroup } from '#src/components/ui/drawer-menu-group';

import { AccentColorSelector } from './color-controls/accent-color-selector';
import { BackgroundColorSelector } from './color-controls/background-color-selector';
import { TranscriptionColorSelector } from './color-controls/transcription-color-selector';
import { PresetThemeSelector } from './preset-theme-selector';

export const ThemeCustomizationMenu = () => {
  return (
    <DrawerMenuGroup summary="Theme Customization" icon={<FormatPaintIcon />}>
      <BackgroundColorSelector />
      <AccentColorSelector />
      <TranscriptionColorSelector />
      <PresetThemeSelector />
    </DrawerMenuGroup>
  );
};
