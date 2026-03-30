import Slider from '@mui/material/Slider';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

import { useDebouncedValue } from '@scribear/core-ui';
import { TRANSCRIPTION_DISPLAY_CONFG } from '@scribear/transcription-display-store';

/**
 * Props for {@link LineHeightControl}.
 */
interface LineHeightControlProps {
  // The current line height multiplier. Displayed as the slider's initial value.
  lineHeightMultipler: number;
  // Callback to update the line height multiplier. Receives the new value (debounced).
  setLineHeightMultipler: (value: number) => void;
}

/**
 * Slider for adjusting the transcription line height multiplier.
 */
export const LineHeightControl = ({
  lineHeightMultipler,
  setLineHeightMultipler,
}: LineHeightControlProps) => {
  const [value, handleChange] = useDebouncedValue(
    lineHeightMultipler,
    setLineHeightMultipler,
  );

  const handleSliderChange = (_: Event, sliderValue: number) => {
    handleChange(sliderValue);
  };

  return (
    <>
      <Typography>Line Height</Typography>
      <Stack direction="row" alignItems="center" spacing={2}>
        <Typography sx={{ minWidth: 75, textAlign: 'left' }}>
          {TRANSCRIPTION_DISPLAY_CONFG.lineHeightMultipler.min}x
        </Typography>
        <Slider
          aria-label="Line height control"
          valueLabelDisplay="auto"
          min={TRANSCRIPTION_DISPLAY_CONFG.lineHeightMultipler.min}
          max={TRANSCRIPTION_DISPLAY_CONFG.lineHeightMultipler.max}
          step={TRANSCRIPTION_DISPLAY_CONFG.lineHeightMultipler.step}
          value={value}
          onChange={handleSliderChange}
        />
        <Typography sx={{ minWidth: 75, textAlign: 'right' }}>
          {TRANSCRIPTION_DISPLAY_CONFG.lineHeightMultipler.max}x
        </Typography>
      </Stack>
    </>
  );
};
