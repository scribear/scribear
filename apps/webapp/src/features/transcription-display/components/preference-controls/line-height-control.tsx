import Slider from '@mui/material/Slider';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

import { DEBOUNCE_DELAY } from '#src/config/contants';
import { useDebouncedReduxValue } from '#src/hooks/use-debounced-redux-value';

import { TRANSCRIPTION_DISPLAY_CONFG } from '../../config/transcription-display-bounds';
import {
  selectLineHeightMultipler,
  setLineHeightMultipler,
} from '../../stores/transcription-display-preferences-slice';

export const LineHeightControl = () => {
  const [lineHeightMultipler, handleLineHeightChange] = useDebouncedReduxValue(
    selectLineHeightMultipler,
    setLineHeightMultipler,
    DEBOUNCE_DELAY,
  );

  const handleChange = (_: Event, value: number) => {
    handleLineHeightChange(value);
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
          value={lineHeightMultipler}
          onChange={handleChange}
        />
        <Typography sx={{ minWidth: 75, textAlign: 'right' }}>
          {TRANSCRIPTION_DISPLAY_CONFG.lineHeightMultipler.max}x
        </Typography>
      </Stack>
    </>
  );
};
