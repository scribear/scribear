import Divider from '@mui/material/Divider';
import Drawer from '@mui/material/Drawer';
import FormControlLabel from '@mui/material/FormControlLabel';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import Typography from '@mui/material/Typography';

export interface VisualizerDrawerProps {
  open: boolean;
  onClose: () => void;
  frequencyEnabled: boolean;
  timeSeriesEnabled: boolean;
  melCepstrumEnabled: boolean;
  onFrequencyToggle: (enabled: boolean) => void;
  onTimeSeriesToggle: (enabled: boolean) => void;
  onMelCepstrumToggle: (enabled: boolean) => void;
}

export const VisualizerDrawer = ({
  open,
  onClose,
  frequencyEnabled,
  timeSeriesEnabled,
  melCepstrumEnabled,
  onFrequencyToggle,
  onTimeSeriesToggle,
  onMelCepstrumToggle,
}: VisualizerDrawerProps) => (
  <Drawer anchor="right" open={open} onClose={onClose}>
    <Stack sx={{ width: 240, p: 2 }} spacing={1}>
      <Typography variant="subtitle1" fontWeight="bold">
        Visualizer Settings
      </Typography>
      <Divider />
      <FormControlLabel
        control={
          <Switch
            checked={frequencyEnabled}
            onChange={(e) => onFrequencyToggle(e.target.checked)}
          />
        }
        label="Frequency Spectrum"
      />
      <FormControlLabel
        control={
          <Switch
            checked={timeSeriesEnabled}
            onChange={(e) => onTimeSeriesToggle(e.target.checked)}
          />
        }
        label="Time Series (Waveform)"
      />
      <FormControlLabel
        control={
          <Switch
            checked={melCepstrumEnabled}
            onChange={(e) => onMelCepstrumToggle(e.target.checked)}
          />
        }
        label="Mel-Frequency Cepstrum"
      />
    </Stack>
  </Drawer>
);
