import { ColorPickerField } from './color-picker-field.js';

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
  return (
    <ColorPickerField
      label="Background Color"
      value={backgroundColor}
      onChange={setBackgroundColor}
    />
  );
};
