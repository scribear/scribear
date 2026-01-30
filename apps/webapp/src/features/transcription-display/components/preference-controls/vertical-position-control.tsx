import Slider from '@mui/material/Slider';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

import { DEBOUNCE_DELAY } from '@/config/contants';
import { useDebouncedReduxValue } from '@/hooks/use-debounced-redux-value';
import type { RootState } from '@/stores/store';
import { useAppSelector } from '@/stores/use-redux';

import { TRANSCRIPTION_DISPLAY_CONFG } from '../../config/transcription-display-bounds';
import { useTranscriptionDisplayHeight } from '../../contexts/transcription-display/transcription-display-context';
import {
  selectBoundedDisplayPreferences,
  selectVerticalPositionBoundsPx,
  setTargetVerticalPositionPx,
} from '../../stores/transcription-display-preferences-slice';

export const VerticalPositionControl = () => {
  const { containerHeightPx } = useTranscriptionDisplayHeight();
  const { minVerticalPositionPx, maxVerticalPositionPx } = useAppSelector(
    (state) => {
      return selectVerticalPositionBoundsPx(state, { containerHeightPx });
    },
  );

  const isDisabled = minVerticalPositionPx === maxVerticalPositionPx;

  const selectVerticalPositionPx = (state: RootState) => {
    return selectBoundedDisplayPreferences(state, { containerHeightPx })
      .verticalPositionPx;
  };

  const [verticalPositionPx, handleVerticalPositionPxChange] =
    useDebouncedReduxValue(
      selectVerticalPositionPx,
      setTargetVerticalPositionPx,
      DEBOUNCE_DELAY,
    );

  const handleChange = (_: Event, value: number) => {
    handleVerticalPositionPxChange(value);
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
          value={verticalPositionPx}
          onChange={handleChange}
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
