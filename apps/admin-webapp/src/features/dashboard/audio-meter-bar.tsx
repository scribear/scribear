import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

import type { AudioStatus } from './fleet-status';

/**
 * The dBFS range the bar spans. Matches the standalone meter
 * (`audio-meter.html`'s `METER_MIN_DB` / `METER_MAX_DB`) so an audio engineer
 * reading both surfaces sees one instrument.
 */
const METER_MIN_DB = -60;
const METER_MAX_DB = 0;

/**
 * Zone tick positions on the bar, in dBFS. The "hot" tick at -6 dBFS matches
 * `AUDIO_THRESHOLDS.rmsDbfsHigh`, an RMS threshold specific to this
 * dashboard (not tied to the standalone meter's peak-zone default, which is a
 * different quantity and can default independently); the "low" tick at
 * -50 dBFS matches `AUDIO_THRESHOLDS.rmsDbfsLow`.
 */
const TICK_HOT_DB = -6;
const TICK_LOW_DB = -50;

const STATUS_ZONE_TEXT: Record<AudioStatus, string> = {
  good: 'level OK',
  warn: 'level out of range',
  crit: 'critical',
  unknown: 'no audio',
};

const STATUS_FILL_COLOR: Record<AudioStatus, string> = {
  good: 'success.main',
  warn: 'warning.main',
  crit: 'error.main',
  unknown: 'text.disabled',
};

function positionPercent(db: number): number {
  const clamped = Math.min(METER_MAX_DB, Math.max(METER_MIN_DB, db));
  return ((clamped - METER_MIN_DB) / (METER_MAX_DB - METER_MIN_DB)) * 100;
}

function formatDb(db: number): string {
  if (!Number.isFinite(db) || db <= -120) return '−∞';
  return db.toFixed(1);
}

export interface AudioMeterBarProps {
  /** RMS level in dBFS. When `null`, the bar renders empty ("no signal"). */
  rmsDbfs: number | null;
  /**
   * Optional sample peak in dBFS, drawn as a vertical marker.
   *
   * This is the publisher's `peakDbfs`: the **maximum over the whole metering
   * window**. Deliberately not called a peak-hold marker — the standalone page's
   * "Peak" readout *is* a hold-and-decay peak meter, and on the same audio it
   * reads lower, because it tracks the recent peak rather than the window's
   * maximum. Same mark, different quantity; see `PEAK_CONVENTION`.
   */
  peakDbfs?: number | null;
  /** Derived audio status, used to colour the fill and the zone text. */
  status: AudioStatus;
  /** Accessible label for the bar, e.g. "Audio level for session abc". */
  label: string;
}

/**
 * How this surface's peak figure differs from the standalone meter page's.
 *
 * Exported so the session detail page and the fleet roll-up state it in one
 * wording (PLAN-AUDIOVIZ §8: audio conventions must be labelled on the surface).
 * The comparable figure on the standalone page is its "Session max true peak",
 * not the "Sample peak (held)" it shows most prominently.
 */
export const PEAK_CONVENTION =
  'Peak is the highest sample in the 10 s metering window. The standalone ' +
  'meter’s "Peak" readout is a hold-and-decay meter that follows the recent ' +
  'peak instead, so it reads lower on the same audio — its comparable figure ' +
  'is "Session max true peak".';

/**
 * Horizontal −60…0 dBFS meter bar with zone ticks and an optional peak marker,
 * mirroring the standalone `audio-meter.html`'s visual language (D4 of
 * PLAN-AUDIOVIZ) so an audio engineer reading both surfaces sees one instrument.
 *
 * The marks are the same; one of the quantities behind them is not. The bar's
 * fill is RMS on both surfaces, but the peak marker here is the window maximum
 * rather than the page's hold-and-decay peak meter — hence `PEAK_CONVENTION`,
 * which the surfaces embedding this bar are expected to surface.
 *
 * The numeric dBFS is always rendered as visible text beside the bar — never
 * color-only, never graphic-only (SC 1.4.1/1.1.1). The bar itself carries
 * `role="progressbar"` with an `aria-valuetext` that says the dB figure and the
 * zone in words, matching the standalone page's pattern; the peak is named there
 * too, since the marker itself is `aria-hidden` and would otherwise be
 * graphic-only.
 */
export const AudioMeterBar = ({
  rmsDbfs,
  peakDbfs,
  status,
  label,
}: AudioMeterBarProps) => {
  const rmsValue =
    rmsDbfs !== null && Number.isFinite(rmsDbfs) ? rmsDbfs : null;
  const fillPct = rmsValue !== null ? positionPercent(rmsValue) : 0;
  const peakPct =
    peakDbfs != null && Number.isFinite(peakDbfs)
      ? positionPercent(peakDbfs)
      : null;
  const zoneText = STATUS_ZONE_TEXT[status];
  const peakValue =
    peakDbfs != null && Number.isFinite(peakDbfs) ? peakDbfs : null;
  // The peak marker is aria-hidden, so name the figure here or it is available
  // to sighted users only. "window peak" rather than a bare "peak" because the
  // standalone meter's "Peak" is a different measurement (PEAK_CONVENTION).
  const peakText =
    peakValue !== null ? `, window peak ${formatDb(peakValue)} dBFS` : '';
  const valuetext =
    rmsValue !== null
      ? `${formatDb(rmsValue)} dBFS RMS${peakText}, ${zoneText}`
      : `No signal${peakText}, ${zoneText}`;

  return (
    <Stack
      direction="row"
      spacing={1}
      sx={{ alignItems: 'center', width: '100%' }}
    >
      <Box
        role="progressbar"
        aria-label={label}
        aria-valuemin={METER_MIN_DB}
        aria-valuemax={METER_MAX_DB}
        aria-valuenow={rmsValue !== null ? Math.round(rmsValue) : METER_MIN_DB}
        aria-valuetext={valuetext}
        sx={{
          position: 'relative',
          height: 14,
          borderRadius: 1,
          width: '100%',
          minWidth: 60,
          bgcolor: 'action.hover',
          overflow: 'hidden',
        }}
      >
        {/* Zone tick: "low" boundary */}
        <Box
          aria-hidden="true"
          sx={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            width: '1px',
            left: `${String(positionPercent(TICK_LOW_DB))}%`,
            bgcolor: 'divider',
          }}
        />
        {/* Zone tick: "hot" boundary */}
        <Box
          aria-hidden="true"
          sx={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            width: '1px',
            left: `${String(positionPercent(TICK_HOT_DB))}%`,
            bgcolor: 'divider',
          }}
        />
        {/* Fill */}
        <Box
          aria-hidden="true"
          sx={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            left: 0,
            width: `${String(fillPct)}%`,
            bgcolor: STATUS_FILL_COLOR[status],
            borderRadius: 1,
          }}
        />
        {/* Peak-hold marker */}
        {peakPct !== null && (
          <Box
            aria-hidden="true"
            sx={{
              position: 'absolute',
              top: 0,
              bottom: 0,
              width: '2px',
              left: `${String(peakPct)}%`,
              bgcolor: 'text.primary',
              transform: 'translateX(-1px)',
            }}
          />
        )}
      </Box>
      <Typography
        variant="caption"
        sx={{
          fontFamily: 'monospace',
          fontVariantNumeric: 'tabular-nums',
          whiteSpace: 'nowrap',
          // `minWidth` alone was not a floor: setting it overrides a flex
          // item's default `min-width: auto`, which is the thing that stops an
          // item shrinking below its content. The bar beside this asks for
          // `width: 100%`, so the readout lost the negotiation and "-23.4 dBFS"
          // rendered clipped mid-word on a session card at every viewport width
          // — measured in a real browser; jsdom has no layout, so no unit test
          // could have seen it. The figure is the accessible value this
          // component exists to show (SC 1.4.1), so it never shrinks; the bar
          // is the part that gives way, down to its own 60px floor.
          flexShrink: 0,
          minWidth: '4.5em',
          textAlign: 'right',
        }}
      >
        {rmsValue !== null ? `${formatDb(rmsValue)} dBFS` : '— dBFS'}
      </Typography>
    </Stack>
  );
};
