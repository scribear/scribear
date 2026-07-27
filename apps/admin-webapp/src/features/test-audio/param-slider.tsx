import { useId } from 'react';

import Box from '@mui/material/Box';
import Slider from '@mui/material/Slider';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

import { useDebouncedValue } from '#src/lib/use-debounced-value';

interface ParamSliderProps {
  /** Visible label. Must be a prefix of `ariaLabel` (SC 2.5.3, Label in Name). */
  label: string;
  /**
   * Accessible name. Distinct from `label` because the two cards carry knobs
   * with the same visible label — a screen-reader user tabbing the page needs
   * to hear which source they are about to detune.
   */
  ariaLabel: string;
  /** What turning this knob is expected to show up as. Associated with the
   *  slider via `aria-describedby`, so it is announced, not just printed. */
  caption?: string;
  value: number;
  min: number;
  max: number;
  step: number;
  /** Renders the value for both the readout and `getAriaValueText`, so the
   *  spoken value carries the same unit as the printed one. */
  formatValue: (v: number) => string;
  /** Endpoint annotations, e.g. what the extremes of the gain range mean. */
  minLabel?: string;
  maxLabel?: string;
  disabled?: boolean;
  /** Called after the debounce, i.e. once per gesture rather than per frame. */
  onCommit: (v: number) => void;
}

/**
 * One numeric parameter, shaped after
 * `libs/ui/…/preference-controls/font-size-control.tsx`: a debounced `Slider`
 * with an explicit `aria-label`, a unit-carrying `getAriaValueText`, and
 * `valueLabelDisplay="auto"`. Copied rather than imported — admin-webapp has no
 * `libs/ui` dependency.
 */
export const ParamSlider = ({
  label,
  ariaLabel,
  caption,
  value,
  min,
  max,
  step,
  formatValue,
  minLabel,
  maxLabel,
  disabled = false,
  onCommit,
}: ParamSliderProps) => {
  const [localValue, handleChange] = useDebouncedValue(value, onCommit);
  const captionId = useId();

  return (
    <Box>
      <Stack
        direction="row"
        spacing={1}
        sx={{ alignItems: 'baseline', justifyContent: 'space-between' }}
      >
        <Typography variant="body2" component="span">
          {label}
        </Typography>
        <Typography
          variant="body2"
          component="span"
          sx={{ color: 'text.secondary', fontVariantNumeric: 'tabular-nums' }}
        >
          {formatValue(localValue)}
        </Typography>
      </Stack>
      <Slider
        aria-label={ariaLabel}
        aria-describedby={caption === undefined ? undefined : captionId}
        getAriaValueText={(v) => formatValue(v)}
        valueLabelDisplay="auto"
        valueLabelFormat={(v: number) => formatValue(v)}
        min={min}
        max={max}
        step={step}
        value={localValue}
        disabled={disabled}
        onChange={(_e: Event, v: number) => {
          handleChange(v);
        }}
        size="small"
      />
      {(minLabel !== undefined || maxLabel !== undefined) && (
        <Stack
          direction="row"
          spacing={1}
          sx={{ justifyContent: 'space-between', mt: -0.5 }}
        >
          <Typography variant="caption" sx={{ color: 'text.secondary' }}>
            {minLabel ?? ''}
          </Typography>
          <Typography variant="caption" sx={{ color: 'text.secondary' }}>
            {maxLabel ?? ''}
          </Typography>
        </Stack>
      )}
      {caption !== undefined && (
        <Typography
          id={captionId}
          variant="caption"
          sx={{ color: 'text.secondary', display: 'block' }}
        >
          {caption}
        </Typography>
      )}
    </Box>
  );
};
