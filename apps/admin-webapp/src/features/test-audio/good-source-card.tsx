import { useState } from 'react';

import Box from '@mui/material/Box';
import FormControl from '@mui/material/FormControl';
import FormControlLabel from '@mui/material/FormControlLabel';
import FormLabel from '@mui/material/FormLabel';
import InputLabel from '@mui/material/InputLabel';
import MenuItem from '@mui/material/MenuItem';
import Radio from '@mui/material/Radio';
import RadioGroup from '@mui/material/RadioGroup';
import Select from '@mui/material/Select';
import type { SelectChangeEvent } from '@mui/material/Select';
import Stack from '@mui/material/Stack';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Typography from '@mui/material/Typography';

import type {
  TestAudioGoodDevice,
  TestAudioGoodParams,
  TestAudioNoiseDb,
  TestAudioNoiseType,
} from '#src/lib/admin-api';

import { DeviceCard } from './device-card';
import { ParamSlider } from './param-slider';
import {
  CLIP_OPTIONS,
  DEFAULT_DURATION_SEC,
  GAIN_DB_MAX,
  GAIN_DB_MAX_LABEL,
  GAIN_DB_MIN,
  GAIN_DB_MIN_LABEL,
  GAIN_DB_STEP,
  NOISE_DB_OPTIONS,
  NOISE_TYPE_OPTIONS,
} from './params-meta';
import { isRunning, useDeviceRun } from './use-test-audio';

const SOURCE_NAME = 'good source';

/**
 * Device 1 (§2.1): clean speech with an adjustable level and noise floor.
 *
 * The card holds its own copy of the parameters. Before the operator touches
 * anything it shows the device's own, so a run someone else started reads
 * truthfully; from the first change onwards the local copy wins and the 3 s
 * poll never overwrites it. That asymmetry is deliberate — a poll that wrote
 * back would fight the debounce and yank a slider out from under a dragging
 * hand, which is precisely the interaction this page exists for.
 */
export const GoodSourceCard = ({
  device,
  refresh,
}: {
  device: TestAudioGoodDevice;
  refresh: () => void;
}) => {
  const [draft, setDraft] = useState<TestAudioGoodParams | null>(null);
  const [durationSec, setDurationSec] = useState(DEFAULT_DURATION_SEC);
  const { busy, start, stop, retune } = useDeviceRun('good', refresh);

  const params = draft ?? device.params;
  const running = isRunning(device);

  const change = <K extends keyof TestAudioGoodParams>(
    key: K,
    value: TestAudioGoodParams[K],
  ) => {
    setDraft({ ...params, [key]: value });
    // Running: retune live rather than restart, so the session survives.
    // Idle: local only, applied at start.
    // Only the knob that moved, so the audit row names it (§3).
    if (running) retune({ [key]: value });
  };

  return (
    <DeviceCard
      device={device}
      title="Good source"
      description="Clean speech at a level you choose, over a noise floor you choose. Start here to confirm captions work at all, then walk the gain down to −40 dB and watch the silence telemetry follow."
      sourceName={SOURCE_NAME}
      durationSec={durationSec}
      onDurationChange={setDurationSec}
      busy={busy}
      onStart={() => {
        start(params, durationSec);
      }}
      onStop={stop}
    >
      <Stack spacing={2.5}>
        <FormControl size="small" fullWidth>
          <InputLabel id="test-audio-good-clip-label">Speech clip</InputLabel>
          <Select
            labelId="test-audio-good-clip-label"
            label="Speech clip"
            value={params.clip}
            onChange={(e: SelectChangeEvent) => {
              change('clip', e.target.value as TestAudioGoodParams['clip']);
            }}
          >
            {CLIP_OPTIONS.map((option) => (
              <MenuItem key={option.value} value={option.value}>
                {option.label}
              </MenuItem>
            ))}
          </Select>
          <Typography
            variant="caption"
            sx={{ color: 'text.secondary', mt: 0.5 }}
          >
            The two committed fixtures are short enough that Whisper&apos;s
            context sees the same sentences repeatedly — use longform to judge
            accuracy over a real lecture&apos;s worth of speech.
          </Typography>
        </FormControl>

        <ParamSlider
          label="Gain"
          ariaLabel={`Gain for the ${SOURCE_NAME}`}
          caption="−40 dB is below the ingress meter's silence floor (0.01 linear RMS) and +20 dB drives the fixture into hard clipping. Both ends are reachable on purpose."
          value={params.gainDb}
          min={GAIN_DB_MIN}
          max={GAIN_DB_MAX}
          step={GAIN_DB_STEP}
          formatValue={(v) => `${v > 0 ? '+' : ''}${String(v)} dB`}
          minLabel={GAIN_DB_MIN_LABEL}
          maxLabel={GAIN_DB_MAX_LABEL}
          onCommit={(v) => {
            change('gainDb', v);
          }}
        />

        <Box>
          <Typography variant="body2" component="p" sx={{ mb: 0.5 }}>
            Noise type
          </Typography>
          <ToggleButtonGroup
            exclusive
            size="small"
            aria-label={`Noise type for the ${SOURCE_NAME}`}
            value={params.noiseType}
            onChange={(_e, value: TestAudioNoiseType | null) => {
              // Null when the operator clicks the already-selected button;
              // there is no "no noise type" state, so ignore it.
              if (value !== null) change('noiseType', value);
            }}
          >
            {NOISE_TYPE_OPTIONS.map((option) => (
              <ToggleButton key={option.value} value={option.value}>
                {option.label}
              </ToggleButton>
            ))}
          </ToggleButtonGroup>
        </Box>

        <FormControl>
          <FormLabel id="test-audio-good-noise-db-label">Noise floor</FormLabel>
          <RadioGroup
            aria-labelledby="test-audio-good-noise-db-label"
            value={String(params.noiseDb)}
            onChange={(_e, value) => {
              change('noiseDb', Number(value) as TestAudioNoiseDb);
            }}
          >
            {NOISE_DB_OPTIONS.map((option) => (
              <FormControlLabel
                key={option.value}
                value={String(option.value)}
                control={<Radio size="small" />}
                label={option.label}
                disabled={params.noiseType === 'none'}
                slotProps={{ typography: { variant: 'body2' } }}
              />
            ))}
          </RadioGroup>
          <Typography variant="caption" sx={{ color: 'text.secondary' }}>
            {params.noiseType === 'none'
              ? 'No noise is being mixed in, so the floor has no effect.'
              : 'Five fixed levels, not a continuum: these are the ones worth comparing.'}
          </Typography>
        </FormControl>
      </Stack>
    </DeviceCard>
  );
};
