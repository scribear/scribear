import Slider from '@mui/material/Slider';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

import { DEBOUNCE_DELAY } from '#src/config/contants';
import { useDebouncedReduxValue } from '#src/hooks/use-debounced-redux-value';

import { TRANSCRIPTION_DISPLAY_CONFG } from '../../config/transcription-display-bounds';
import {
  selectFontSizePx,
  setFontSizePx,
} from '../../stores/transcription-display-preferences-slice';

export const FontSizeControl = () => {
  const [fontSizePx, handleFontSizeChange] = useDebouncedReduxValue(
    selectFontSizePx,
    setFontSizePx,
    DEBOUNCE_DELAY,
  );

  const handleChange = (_: Event, value: number) => {
    handleFontSizeChange(value);
  };

  return (
    <>
      <Typography>Font Size</Typography>
      <Stack direction="row" alignItems="center" spacing={2}>
        <Typography sx={{ minWidth: 75, textAlign: 'left' }}>
          {TRANSCRIPTION_DISPLAY_CONFG.fontSizePx.min} px
        </Typography>
        <Slider
          aria-label="Font size control"
          valueLabelDisplay="auto"
          min={TRANSCRIPTION_DISPLAY_CONFG.fontSizePx.min}
          max={TRANSCRIPTION_DISPLAY_CONFG.fontSizePx.max}
          step={TRANSCRIPTION_DISPLAY_CONFG.fontSizePx.step}
          value={fontSizePx}
          onChange={handleChange}
        />
        <Typography sx={{ minWidth: 75, textAlign: 'right' }}>
          {TRANSCRIPTION_DISPLAY_CONFG.fontSizePx.max} px
        </Typography>
      </Stack>
    </>
  );
};
