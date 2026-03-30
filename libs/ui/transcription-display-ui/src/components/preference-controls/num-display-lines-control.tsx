import Slider from '@mui/material/Slider';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

import { useDebouncedValue } from '@scribear/core-ui';
import { TRANSCRIPTION_DISPLAY_CONFG } from '@scribear/transcription-display-store';

import { useTranscriptionDisplayHeight } from '#src/contexts/transcription-display-height-context.js';

/**
 * Min/max bounds for the number of visible transcription lines, derived from container height.
 */
interface NumDisplayLinesBounds {
  minNumDisplayLines: number;
  maxNumDisplayLines: number;
}

/**
 * Bounded display preferences resolved against the current container height.
 */
interface BoundedDisplayPreferences {
  verticalPositionPx: number;
  numDisplayLines: number;
}

/**
 * Props for {@link NumDisplayLinesControl}.
 */
interface NumDisplayLinesControlProps {
  // Returns the min/max number of displayable lines given the current container height.
  getNumDisplayLinesBounds: (
    containerHeightPx: number,
  ) => NumDisplayLinesBounds;
  // Returns the current display preferences (vertical position and line count) clamped to the container height.
  getBoundedDisplayPreferences: (
    containerHeightPx: number,
  ) => BoundedDisplayPreferences;
  // Callback to update the target number of display lines. Receives the new value (debounced).
  setTargetDisplayLines: (value: number) => void;
}

/**
 * Slider for adjusting the number of visible transcription lines.
 * Disabled when the container is too small to fit more than one line configuration.
 */
export const NumDisplayLinesControl = ({
  getNumDisplayLinesBounds,
  getBoundedDisplayPreferences,
  setTargetDisplayLines,
}: NumDisplayLinesControlProps) => {
  const { containerHeightPx } = useTranscriptionDisplayHeight();

  const { minNumDisplayLines, maxNumDisplayLines } =
    getNumDisplayLinesBounds(containerHeightPx);
  const { numDisplayLines } = getBoundedDisplayPreferences(containerHeightPx);

  const isDisabled = minNumDisplayLines === maxNumDisplayLines;

  const [value, handleChange] = useDebouncedValue(
    numDisplayLines,
    setTargetDisplayLines,
  );

  const handleSliderChange = (_: Event, sliderValue: number) => {
    handleChange(sliderValue);
  };

  return (
    <>
      <Typography>Number of Display Lines</Typography>
      <Stack direction="row" alignItems="center" spacing={2}>
        <Typography sx={{ minWidth: 75, textAlign: 'left' }}>
          {minNumDisplayLines}
        </Typography>
        <Slider
          aria-label="Number of display lines control"
          valueLabelDisplay="auto"
          min={minNumDisplayLines}
          max={maxNumDisplayLines}
          step={TRANSCRIPTION_DISPLAY_CONFG.displayLines.step}
          disabled={isDisabled}
          value={value}
          onChange={handleSliderChange}
        />
        <Typography sx={{ minWidth: 75, textAlign: 'right' }}>
          {maxNumDisplayLines}
        </Typography>
      </Stack>
      <Typography
        color="warning"
        sx={{
          display: isDisabled ? 'block' : 'none',
          textAlign: 'center',
        }}
      >
        Not enough space to adjust number of display lines. Try decreasing font
        size, line height, or vertical position.
      </Typography>
    </>
  );
};
