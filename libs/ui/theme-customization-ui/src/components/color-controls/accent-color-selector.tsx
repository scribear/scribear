import { ColorPickerField } from './color-picker-field.js';

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
  return (
    <ColorPickerField
      label="Accent Color"
      value={accentColor}
      onChange={setAccentColor}
    />
  );
};
