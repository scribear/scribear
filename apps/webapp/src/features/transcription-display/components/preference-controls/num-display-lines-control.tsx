import Slider from '@mui/material/Slider';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

import { DEBOUNCE_DELAY } from '#src/config/contants';
import { useDebouncedReduxValue } from '#src/hooks/use-debounced-redux-value';
import type { RootState } from '#src/stores/store';
import { useAppSelector } from '#src/stores/use-redux';

import { TRANSCRIPTION_DISPLAY_CONFG } from '../../config/transcription-display-bounds';
import { useTranscriptionDisplayHeight } from '../../contexts/transcription-display/transcription-display-context';
import {
  selectBoundedDisplayPreferences,
  selectNumDisplayLinesBounds,
  setTargetDisplayLines,
} from '../../stores/transcription-display-preferences-slice';

export const NumDisplayLinesControl = () => {
  const { containerHeightPx } = useTranscriptionDisplayHeight();
  const { minNumDisplayLines, maxNumDisplayLines } = useAppSelector((state) => {
    return selectNumDisplayLinesBounds(state, { containerHeightPx });
  });

  const isDisabled = minNumDisplayLines === maxNumDisplayLines;

  const selectNumDisplayLines = (state: RootState) => {
    return selectBoundedDisplayPreferences(state, { containerHeightPx })
      .numDisplayLines;
  };

  const [numDisplayLines, handleNumDisplayLinesChange] = useDebouncedReduxValue(
    selectNumDisplayLines,
    setTargetDisplayLines,
    DEBOUNCE_DELAY,
  );

  const handleChange = (_: Event, value: number) => {
    handleNumDisplayLinesChange(value);
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
          value={numDisplayLines}
          onChange={handleChange}
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
