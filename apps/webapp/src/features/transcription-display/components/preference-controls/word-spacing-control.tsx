import Slider from '@mui/material/Slider';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

import { DEBOUNCE_DELAY } from '@/config/contants';
import { useDebouncedReduxValue } from '@/hooks/use-debounced-redux-value';

import { TRANSCRIPTION_DISPLAY_CONFG } from '../../config/transcription-display-bounds';
import {
  selectWordSpacingEm,
  setWordSpacingEm,
} from '../../stores/transcription-display-preferences-slice';

export const WordSpacingControl = () => {
  const [wordSpacingEm, handleWordSpacingChange] = useDebouncedReduxValue(
    selectWordSpacingEm,
    setWordSpacingEm,
    DEBOUNCE_DELAY,
  );

  const handleChange = (_: Event, value: number) => {
    handleWordSpacingChange(value);
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
          value={wordSpacingEm}
          onChange={handleChange}
        />
        <Typography sx={{ minWidth: 75, textAlign: 'right' }}>
          {TRANSCRIPTION_DISPLAY_CONFG.wordSpacingEm.max}x
        </Typography>
      </Stack>
    </>
  );
};
