import Box from '@mui/material/Box';
import FormControlLabel from '@mui/material/FormControlLabel';
import Slider from '@mui/material/Slider';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import Typography from '@mui/material/Typography';

import {
  selectFontSize,
  selectShowJoinCode,
  setFontSize,
  setShowJoinCode,
} from '#src/features/cross-screen/stores/display-settings-slice';
import { useAppDispatch, useAppSelector } from '#src/store/use-redux';

const MIN_FONT_SIZE = 12;
const MAX_FONT_SIZE = 72;

export const DisplaySettingsPanel = () => {
  const dispatch = useAppDispatch();
  const fontSize = useAppSelector(selectFontSize);
  const showJoinCode = useAppSelector(selectShowJoinCode);

  return (
    <Box>
      <Typography variant="h6" gutterBottom>
        Display Settings
      </Typography>
      <Stack spacing={3}>
        <Stack direction="row" alignItems="center" spacing={2}>
          <Typography sx={{ minWidth: 100 }}>Font Size: {fontSize}px</Typography>
          <Slider
            value={fontSize}
            min={MIN_FONT_SIZE}
            max={MAX_FONT_SIZE}
            onChange={(_, value) => dispatch(setFontSize(value as number))}
            sx={{ flex: 1 }}
          />
        </Stack>
        <FormControlLabel
          control={
            <Switch
              checked={showJoinCode}
              onChange={(e) => dispatch(setShowJoinCode(e.target.checked))}
            />
          }
          label="Show join code on large display"
        />
      </Stack>
    </Box>
  );
};
