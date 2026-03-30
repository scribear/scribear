import Slider from '@mui/material/Slider';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

import { useDebouncedValue } from '@scribear/core-ui';
import { TRANSCRIPTION_DISPLAY_CONFG } from '@scribear/transcription-display-store';

/**
 * Props for {@link WordSpacingControl}.
 */
interface WordSpacingControlProps {
  // The current word spacing in em units. Displayed as the slider's initial value.
  wordSpacingEm: number;
  // Callback to update the word spacing. Receives the new em value (debounced).
  setWordSpacingEm: (value: number) => void;
}

/**
 * Slider for adjusting the transcription word spacing.
 */
export const WordSpacingControl = ({
  wordSpacingEm,
  setWordSpacingEm,
}: WordSpacingControlProps) => {
  const [value, handleChange] = useDebouncedValue(
    wordSpacingEm,
    setWordSpacingEm,
  );

  const handleSliderChange = (_: Event, sliderValue: number) => {
    handleChange(sliderValue);
  };

  return (
    <>
      <Typography>Word Spacing</Typography>
      <Stack direction="row" alignItems="center" spacing={2}>
        <Typography sx={{ minWidth: 75, textAlign: 'left' }}>
          {TRANSCRIPTION_DISPLAY_CONFG.wordSpacingEm.min}x
        </Typography>
        <Slider
          aria-label="Word spacing control"
          valueLabelDisplay="auto"
          min={TRANSCRIPTION_DISPLAY_CONFG.wordSpacingEm.min}
          max={TRANSCRIPTION_DISPLAY_CONFG.wordSpacingEm.max}
          step={TRANSCRIPTION_DISPLAY_CONFG.wordSpacingEm.step}
          value={value}
          onChange={handleSliderChange}
        />
        <Typography sx={{ minWidth: 75, textAlign: 'right' }}>
          {TRANSCRIPTION_DISPLAY_CONFG.wordSpacingEm.max}x
        </Typography>
      </Stack>
    </>
  );
};
