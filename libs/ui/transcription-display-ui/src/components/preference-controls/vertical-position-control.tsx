import Slider from '@mui/material/Slider';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

import { useDebouncedValue } from '@scribear/core-ui';
import { TRANSCRIPTION_DISPLAY_CONFG } from '@scribear/transcription-display-store';

import { useTranscriptionDisplayHeight } from '#src/contexts/transcription-display-height-context.js';

/**
 * Min/max pixel bounds for the transcription vertical position, derived from container height.
 */
interface VerticalPositionBoundsPx {
  minVerticalPositionPx: number;
  maxVerticalPositionPx: number;
}

/**
 * Bounded display preferences resolved against the current container height.
 */
interface BoundedDisplayPreferences {
  verticalPositionPx: number;
  numDisplayLines: number;
}

/**
 * Props for {@link VerticalPositionControl}.
 */
interface VerticalPositionControlProps {
  // Returns the min/max vertical position in pixels given the current container height.
  getVerticalPositionBoundsPx: (
    containerHeightPx: number,
  ) => VerticalPositionBoundsPx;
  // Returns the current display preferences (vertical position and line count) clamped to the container height.
  getBoundedDisplayPreferences: (
    containerHeightPx: number,
  ) => BoundedDisplayPreferences;
  // Callback to update the target vertical position. Receives the new pixel value (debounced).
  setTargetVerticalPositionPx: (value: number) => void;
}

/**
 * Slider for adjusting the vertical position of the transcription text within the container.
 * Disabled when the container is too small to allow positioning.
 */
export const VerticalPositionControl = ({
  getVerticalPositionBoundsPx,
  getBoundedDisplayPreferences,
  setTargetVerticalPositionPx,
}: VerticalPositionControlProps) => {
  const { containerHeightPx } = useTranscriptionDisplayHeight();

  const { minVerticalPositionPx, maxVerticalPositionPx } =
    getVerticalPositionBoundsPx(containerHeightPx);
  const { verticalPositionPx } =
    getBoundedDisplayPreferences(containerHeightPx);

  const isDisabled = minVerticalPositionPx === maxVerticalPositionPx;

  const [value, handleChange] = useDebouncedValue(
    verticalPositionPx,
    setTargetVerticalPositionPx,
  );

  const handleSliderChange = (_: Event, sliderValue: number) => {
    handleChange(sliderValue);
  };

  return (
    <>
      <Typography>Vertical Position</Typography>
      <Stack direction="row" alignItems="center" spacing={2}>
        <Typography sx={{ minWidth: 75, textAlign: 'left' }}>
          {minVerticalPositionPx} px
        </Typography>
        <Slider
          aria-label="Vertical position control"
          valueLabelDisplay="auto"
          min={minVerticalPositionPx}
          max={maxVerticalPositionPx}
          step={TRANSCRIPTION_DISPLAY_CONFG.verticalPositionPx.step}
          disabled={isDisabled}
          value={value}
          onChange={handleSliderChange}
        />
        <Typography sx={{ minWidth: 75, textAlign: 'right' }}>
          {maxVerticalPositionPx} px
        </Typography>
      </Stack>
      <Typography
        color="warning"
        sx={{
          display: isDisabled ? 'block' : 'none',
          textAlign: 'center',
        }}
      >
        Not enough space to adjust vertical position. Try decreasing font size
        or line height.
      </Typography>
    </>
  );
};
