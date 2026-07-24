import { ColorPickerField } from './color-picker-field.js';

/**
 * Props for {@link TranscriptionColorSelector}.
 */
interface TranscriptionColorSelectorProps {
  // The current transcription text color, as a CSS hex color string (e.g. "#ffffff"). Displayed as the initial value in the color picker.
  transcriptionColor: string;
  // Callback to update the transcription text color. Receives the new hex color string after the user finishes picking (debounced).
  setTranscriptionColor: (value: string) => void;
}

/**
 * Labeled hex color picker for the transcription text color.
 */
export const TranscriptionColorSelector = ({
  transcriptionColor,
  setTranscriptionColor,
}: TranscriptionColorSelectorProps) => {
  return (
    <ColorPickerField
      label="Transcription Color"
      value={transcriptionColor}
      onChange={setTranscriptionColor}
    />
  );
};
