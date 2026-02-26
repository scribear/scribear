import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

import { MuiColorInput } from 'mui-color-input';

import { DEBOUNCE_DELAY } from '#src/config/contants';
import { useDebouncedReduxValue } from '#src/hooks/use-debounced-redux-value';

import {
  selectBackgroundColor,
  setBackgroundColor,
} from '../../stores/theme-preferences-slice';

export const BackgroundColorSelector = () => {
  const [backgroundColor, handleBackgroundColorChange] = useDebouncedReduxValue(
    selectBackgroundColor,
    setBackgroundColor,
    DEBOUNCE_DELAY,
  );

  return (
    <Stack direction="row" alignItems="center" justifyContent="space-between">
      <Typography>Background Color</Typography>
      <MuiColorInput
        aria-label="Background Color Selector"
        sx={{ width: '8em' }}
        format="hex"
        isAlphaHidden={true}
        value={backgroundColor}
        onChange={handleBackgroundColorChange}
      />
    </Stack>
  );
};
