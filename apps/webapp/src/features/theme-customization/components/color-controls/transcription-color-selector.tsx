import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

import { MuiColorInput } from 'mui-color-input';

import { DEBOUNCE_DELAY } from '@/config/contants';
import { useDebouncedReduxValue } from '@/hooks/use-debounced-redux-value';

import {
  selectTranscriptionColor,
  setTranscriptionColor,
} from '../../stores/theme-preferences-slice';

export const TranscriptionColorSelector = () => {
  const [transcriptionColor, handleTranscriptionColorChange] =
    useDebouncedReduxValue(
      selectTranscriptionColor,
      setTranscriptionColor,
      DEBOUNCE_DELAY,
    );

  return (
    <Stack direction="row" alignItems="center" justifyContent="space-between">
      <Typography>Transcription Color</Typography>
      <MuiColorInput
        aria-label="Transcription Text Color Selector"
        sx={{ width: '8em' }}
        format="hex"
        isAlphaHidden={true}
        value={transcriptionColor}
        onChange={handleTranscriptionColorChange}
      />
    </Stack>
  );
};
