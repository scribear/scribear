import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

import { MuiColorInput, MuiColorInputButton } from 'mui-color-input';

import { useDebouncedValue } from '@scribear/core-ui';

/**
 * Props for {@link ColorPickerField}.
 */
interface ColorPickerFieldProps {
  // Visible label; also the accessible name of the hex input (no 2.5.3 mismatch).
  label: string;
  // Current hex color value (e.g. "#ffffff").
  value: string;
  // Called with the new hex value after the user finishes picking (debounced).
  onChange: (value: string) => void;
}

/**
 * Labeled hex color picker used by the background / accent / transcription
 * color selectors. Centralizes the accessibility wiring for `mui-color-input`,
 * which by default names neither its text input nor its color-preview button:
 * the input gets an `aria-label` matching the visible label (SC 1.3.1, 2.5.3)
 * and the preview button is named via the `Adornment` slot (SC 4.1.2).
 */
export const ColorPickerField = ({
  label,
  value,
  onChange,
}: ColorPickerFieldProps) => {
  const [current, handleChange] = useDebouncedValue(value, onChange);

  return (
    <Stack direction="row" alignItems="center" justifyContent="space-between">
      <Typography>{label}</Typography>
      <MuiColorInput
        sx={{ width: '8em' }}
        format="hex"
        isAlphaHidden
        value={current}
        onChange={handleChange}
        slotProps={{ htmlInput: { 'aria-label': label } }}
        Adornment={(props) => (
          <MuiColorInputButton {...props} aria-label={`${label} picker`} />
        )}
      />
    </Stack>
  );
};
