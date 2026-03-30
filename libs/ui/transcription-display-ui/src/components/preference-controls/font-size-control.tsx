import Slider from '@mui/material/Slider';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

import { useDebouncedValue } from '@scribear/core-ui';
import { TRANSCRIPTION_DISPLAY_CONFG } from '@scribear/transcription-display-store';

/**
 * Props for {@link FontSizeControl}.
 */
interface FontSizeControlProps {
  // The current font size in pixels. Displayed as the slider's initial value.
  fontSizePx: number;
  // Callback to update the font size. Receives the new pixel value (debounced).
  setFontSizePx: (value: number) => void;
}

/**
 * Slider for adjusting the transcription font size.
 */
export const FontSizeControl = ({
  fontSizePx,
  setFontSizePx,
}: FontSizeControlProps) => {
  const [value, handleChange] = useDebouncedValue(fontSizePx, setFontSizePx);

  const handleSliderChange = (_: Event, sliderValue: number) => {
    handleChange(sliderValue);
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
          value={value}
          onChange={handleSliderChange}
        />
        <Typography sx={{ minWidth: 75, textAlign: 'right' }}>
          {TRANSCRIPTION_DISPLAY_CONFG.fontSizePx.max} px
        </Typography>
      </Stack>
    </>
  );
};
