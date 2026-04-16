import Box from '@mui/material/Box';
import FormControlLabel from '@mui/material/FormControlLabel';
import Slider from '@mui/material/Slider';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import Typography from '@mui/material/Typography';
import TextFieldsIcon from '@mui/icons-material/TextFields';
import QrCodeIcon from '@mui/icons-material/QrCode';

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
    <Stack spacing={2}>
      <Typography
        variant="overline"
        color="text.secondary"
        sx={{ letterSpacing: 1.5 }}
      >
        Display Settings
      </Typography>

      {/* Font size row */}
      <Stack direction="row" alignItems="center" spacing={2}>
        <TextFieldsIcon sx={{ fontSize: 20, color: 'text.secondary', flexShrink: 0 }} />
        <Box sx={{ flex: 1 }}>
          <Stack direction="row" justifyContent="space-between" mb={0.5}>
            <Typography variant="body2" color="text.secondary">
              Font Size
            </Typography>
            <Typography variant="body2" fontWeight={600} fontFamily="monospace">
              {fontSize}px
            </Typography>
          </Stack>
          <Slider
            value={fontSize}
            min={MIN_FONT_SIZE}
            max={MAX_FONT_SIZE}
            onChange={(_, value) => dispatch(setFontSize(value as number))}
            size="medium"
            sx={{ py: 1 }}
          />
        </Box>
      </Stack>

      {/* Join code toggle row */}
      <Stack direction="row" alignItems="center" spacing={2}>
        <QrCodeIcon sx={{ fontSize: 20, color: 'text.secondary', flexShrink: 0 }} />
        <FormControlLabel
          control={
            <Switch
              checked={showJoinCode}
              onChange={(e) => dispatch(setShowJoinCode(e.target.checked))}
            />
          }
          label={
            <Typography variant="body2" color="text.secondary">
              Show join code on display
            </Typography>
          }
          sx={{ m: 0 }}
        />
      </Stack>
    </Stack>
  );
};
