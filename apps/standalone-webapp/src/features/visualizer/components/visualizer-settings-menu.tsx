import BarChartIcon from '@mui/icons-material/BarChart';
import FormControlLabel from '@mui/material/FormControlLabel';
import Switch from '@mui/material/Switch';

import { DrawerMenuGroup } from '@scribear/core-ui';
import {
  selectEnabledVisualizers,
  setFrequencyEnabled,
  setMelCepstrumEnabled,
  setTimeSeriesEnabled,
} from '@scribear/visualizer-store';

import { useAppDispatch, useAppSelector } from '#src/store/use-redux';

export const VisualizerSettingsMenu = () => {
  const dispatch = useAppDispatch();
  const { frequency, timeSeries, melCepstrum } = useAppSelector(
    selectEnabledVisualizers,
  );

  return (
    <DrawerMenuGroup summary="Visualizer" icon={<BarChartIcon />}>
      <FormControlLabel
        control={
          <Switch
            checked={frequency}
            onChange={(e) => dispatch(setFrequencyEnabled(e.target.checked))}
          />
        }
        label="Frequency Spectrum"
      />
      <FormControlLabel
        control={
          <Switch
            checked={timeSeries}
            onChange={(e) => dispatch(setTimeSeriesEnabled(e.target.checked))}
          />
        }
        label="Time Series (Waveform)"
      />
      <FormControlLabel
        control={
          <Switch
            checked={melCepstrum}
            onChange={(e) => dispatch(setMelCepstrumEnabled(e.target.checked))}
          />
        }
        label="Mel-Frequency Cepstrum"
      />
    </DrawerMenuGroup>
  );
};
