import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

import { MuiColorInput } from 'mui-color-input';

import { useDebouncedValue } from '@scribear/core-ui';

/**
 * Props for {@link AccentColorSelector}.
 */
interface AccentColorSelectorProps {
  // The current accent color, as a CSS hex color string (e.g. "#4a90d9"). Displayed as the initial value in the color picker.
  accentColor: string;
  // Callback to update the accent color. Receives the new hex color string after the user finishes picking (debounced).
  setAccentColor: (value: string) => void;
}

/**
 * Labeled hex color picker for the UI accent color.
 */
export const AccentColorSelector = ({
  accentColor,
  setAccentColor,
}: AccentColorSelectorProps) => {
  const [value, handleChange] = useDebouncedValue(accentColor, setAccentColor);

  return (
    <Stack direction="row" alignItems="center" justifyContent="space-between">
      <Typography>Accent Color</Typography>
      <MuiColorInput
        aria-label="Accent Color Selector"
        sx={{ width: '8em' }}
        format="hex"
        isAlphaHidden={true}
        value={value}
        onChange={handleChange}
      />
    </Stack>
  );
};
