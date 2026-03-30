import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

import { MuiColorInput } from 'mui-color-input';

import { useDebouncedValue } from '@scribear/core-ui';

/**
 * Props for {@link BackgroundColorSelector}.
 */
interface BackgroundColorSelectorProps {
  // The current background color, as a CSS hex color string (e.g. "#1a1a2e"). Displayed as the initial value in the color picker.
  backgroundColor: string;
  // Callback to update the background color. Receives the new hex color string after the user finishes picking (debounced).
  setBackgroundColor: (value: string) => void;
}

/**
 * Labeled hex color picker for the app background color.
 */
export const BackgroundColorSelector = ({
  backgroundColor,
  setBackgroundColor,
}: BackgroundColorSelectorProps) => {
  const [value, handleChange] = useDebouncedValue(
    backgroundColor,
    setBackgroundColor,
  );

  return (
    <Stack direction="row" alignItems="center" justifyContent="space-between">
      <Typography>Background Color</Typography>
      <MuiColorInput
        aria-label="Background Color Selector"
        sx={{ width: '8em' }}
        format="hex"
        isAlphaHidden={true}
        value={value}
        onChange={handleChange}
      />
    </Stack>
  );
};
