import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

import { MuiColorInput } from 'mui-color-input';

import { DEBOUNCE_DELAY } from '#src/config/contants';
import { useDebouncedReduxValue } from '#src/hooks/use-debounced-redux-value';

import {
  selectAccentColor,
  setAccentColor,
} from '../../stores/theme-preferences-slice';

export const AccentColorSelector = () => {
  const [accentColor, handleAccentColorChange] = useDebouncedReduxValue(
    selectAccentColor,
    setAccentColor,
    DEBOUNCE_DELAY,
  );

  return (
    <Stack direction="row" alignItems="center" justifyContent="space-between">
      <Typography>Accent Color</Typography>
      <MuiColorInput
        aria-label="Accent Color Selector"
        sx={{ width: '8em' }}
        format="hex"
        isAlphaHidden={true}
        value={accentColor}
        onChange={handleAccentColorChange}
      />
    </Stack>
  );
};
