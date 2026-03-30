import { useState } from 'react';

import PaletteIcon from '@mui/icons-material/Palette';
import Box from '@mui/material/Box';
import ButtonBase from '@mui/material/ButtonBase';
import Grid from '@mui/material/Grid';
import IconButton from '@mui/material/IconButton';
import Popover from '@mui/material/Popover';
import Stack from '@mui/material/Stack';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';

import type { ThemeColors } from '@scribear/theme-customization-store';

import { PRESET_THEMES } from '#src/config/preset-themes.js';

/**
 * Props for {@link PresetThemeSelector}.
 */
interface PresetThemeSelectorProps {
  // Callback invoked when the user clicks a preset theme swatch. Receives a ThemeColors object
  // containing backgroundColor, accentColor, and transcriptionColor to apply all three at once.
  applyPresetTheme: (theme: ThemeColors) => void;
}

/**
 * Palette icon button that opens a popover grid of preset color themes.
 */
export const PresetThemeSelector = ({
  applyPresetTheme,
}: PresetThemeSelectorProps) => {
  const [themeSelectorAnchorEl, setThemeSelectorAnchorEl] =
    useState<HTMLButtonElement | null>(null);
  const isThemeSelectorOpen = Boolean(themeSelectorAnchorEl);

  const showPresetThemeSelector = (
    event: React.MouseEvent<HTMLButtonElement>,
  ) => {
    setThemeSelectorAnchorEl(event.currentTarget);
  };

  const hidePresetThemeSelector = () => {
    setThemeSelectorAnchorEl(null);
  };

  const handleApplyPresetTheme = (theme: ThemeColors) => {
    applyPresetTheme(theme);
  };

  return (
    <Stack direction="row" alignItems="center" justifyContent="space-between">
      <Typography>Preset Themes</Typography>

      <Box
        sx={{
          display: 'flex',
          justifyContent: 'center',
          width: '8em',
        }}
      >
        <Tooltip title="View Preset Themes">
          <IconButton color="inherit" onClick={showPresetThemeSelector}>
            <PaletteIcon />
          </IconButton>
        </Tooltip>
      </Box>

      <Popover
        open={isThemeSelectorOpen}
        anchorEl={themeSelectorAnchorEl}
        onClose={hidePresetThemeSelector}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        transformOrigin={{ vertical: 'top', horizontal: 'left' }}
      >
        <Grid container padding={2} spacing={2} sx={{ width: 224 }}>
          {PRESET_THEMES.map((theme) => (
            <Grid size={3} key={theme.id}>
              <Tooltip title={theme.name}>
                <ButtonBase
                  onClick={() => {
                    handleApplyPresetTheme(theme);
                  }}
                  sx={{
                    width: '36px',
                    height: '36px',
                    border: '2px solid',
                    borderColor: theme.accentColor,
                    backgroundColor: theme.backgroundColor,
                    borderRadius: 1,
                  }}
                >
                  <Typography
                    variant="body2"
                    sx={{
                      color: theme.transcriptionColor,
                      fontWeight: 'bold',
                      lineHeight: 1,
                    }}
                  >
                    T
                  </Typography>
                </ButtonBase>
              </Tooltip>
            </Grid>
          ))}
        </Grid>
      </Popover>
    </Stack>
  );
};
