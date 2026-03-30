import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

import { MuiColorInput } from 'mui-color-input';

import { useDebouncedValue } from '@scribear/core-ui';

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
  const [value, handleChange] = useDebouncedValue(
    transcriptionColor,
    setTranscriptionColor,
  );

  return (
    <Stack direction="row" alignItems="center" justifyContent="space-between">
      <Typography>Transcription Color</Typography>
      <MuiColorInput
        aria-label="Transcription Text Color Selector"
        sx={{ width: '8em' }}
        format="hex"
        isAlphaHidden={true}
        value={value}
        onChange={handleChange}
      />
    </Stack>
  );
};
