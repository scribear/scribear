import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

import type { CapacityStatus, ProviderCapacity } from './fleet-status';
import { deriveCapacityStatus } from './fleet-status';

const STATUS_FILL_COLOR: Record<CapacityStatus, string> = {
  good: 'success.main',
  warn: 'warning.main',
  crit: 'error.main',
  unknown: 'text.disabled',
};

const STATUS_ZONE_TEXT: Record<CapacityStatus, string> = {
  good: 'within capacity',
  warn: 'near capacity',
  crit: 'over capacity',
  unknown: 'capacity not yet measured',
};

function fillPercent(live: number, estimated: number): number {
  if (estimated <= 0) return live > 0 ? 100 : 0;
  return Math.min(100, Math.max(0, (live / estimated) * 100));
}

export interface CapacityMeterBarProps {
  /** Aggregated live-vs-estimated reading, from `deriveProviderCapacity`. */
  capacity: ProviderCapacity;
  /** Accessible label for the bar, e.g. "Capacity for provider whisper". */
  label: string;
}

/**
 * Live-sessions-vs-estimated-ceiling meter, one provider's "N / N*"
 * (PLAN-AdmissionControl.md §5).
 *
 * Follows `AudioMeterBar`'s pattern rather than reusing it: that component's
 * range is a fixed -60..0 dBFS with audio-specific tick marks, which would
 * have to be force-fit to represent a session count against a ceiling that
 * moves as the estimator re-measures it. This is a plain 0..N* bar instead.
 *
 * `capacity.applicable === false` (a non-`local` provider, e.g. `lumen_granite`)
 * renders "not applicable" text and no bar at all — a capacity ceiling is a
 * local-worker-pool question, and a remote API's real constraint (upstream
 * rate limits) is a different, deferred one; showing a bar here would invite
 * reading it as a real number (PLAN-AdmissionControl.md §5: "leave a clear
 * gap... rather than a fake number").
 *
 * The numeric "N / N*" is always rendered as visible text beside the bar —
 * never colour-only (SC 1.4.1), matching `AudioMeterBar`. The bar carries
 * `role="progressbar"` with a full `aria-valuetext`; while the estimate is
 * `null` (warm-up, or a provider with no owning worker yet) the bar renders
 * indeterminate — `aria-valuenow`/`aria-valuemin`/`aria-valuemax` are omitted
 * rather than guessed, per the ARIA indeterminate-progressbar pattern.
 */
export const CapacityMeterBar = ({
  capacity,
  label,
}: CapacityMeterBarProps) => {
  const { applicable, liveSessions, estimatedCapacitySessions } = capacity;

  if (!applicable) {
    return (
      <Typography
        variant="caption"
        sx={{ color: 'text.secondary', fontStyle: 'italic' }}
      >
        not applicable
      </Typography>
    );
  }

  const status = deriveCapacityStatus(capacity);
  const known = estimatedCapacitySessions !== null;
  const pct = known ? fillPercent(liveSessions, estimatedCapacitySessions) : 0;
  const zoneText = STATUS_ZONE_TEXT[status];
  const valuetext = known
    ? `${String(liveSessions)} of ${String(estimatedCapacitySessions)} estimated sessions, ${zoneText}`
    : `${String(liveSessions)} live sessions, ${zoneText}`;
  const readoutText = known
    ? `${String(liveSessions)} / ${String(estimatedCapacitySessions)}`
    : `${String(liveSessions)} / warming up`;

  return (
    <Stack
      direction="row"
      spacing={1}
      sx={{ alignItems: 'center', width: '100%' }}
    >
      <Box
        role="progressbar"
        aria-label={label}
        {...(known
          ? {
              'aria-valuemin': 0,
              'aria-valuemax': estimatedCapacitySessions,
              'aria-valuenow': liveSessions,
            }
          : {})}
        aria-valuetext={valuetext}
        sx={{
          position: 'relative',
          height: 10,
          borderRadius: 1,
          width: '100%',
          minWidth: 60,
          bgcolor: 'action.hover',
          overflow: 'hidden',
        }}
      >
        <Box
          aria-hidden="true"
          sx={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            left: 0,
            width: `${String(pct)}%`,
            bgcolor: STATUS_FILL_COLOR[status],
            borderRadius: 1,
          }}
        />
      </Box>
      <Typography
        variant="caption"
        sx={{
          fontFamily: 'monospace',
          fontVariantNumeric: 'tabular-nums',
          whiteSpace: 'nowrap',
          // Same reasoning as `AudioMeterBar`'s readout: `minWidth` alone does
          // not stop this shrinking beside a `width: 100%` bar in a flex row,
          // only `flexShrink: 0` does — see that component's comment for the
          // measured failure this avoids.
          flexShrink: 0,
          minWidth: '5em',
          textAlign: 'right',
        }}
      >
        {readoutText}
      </Typography>
    </Stack>
  );
};
