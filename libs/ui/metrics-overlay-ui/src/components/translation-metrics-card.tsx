import Box from '@mui/material/Box';

import { MetricsCard } from '#src/components/metrics-card.js';
import {
  formatMs,
  metricHeaderCellSx,
  metricValueCellSx,
} from '#src/metrics-display.js';

/**
 * A rolling measurement: the newest sample beside its moving average, both in
 * milliseconds. 0 means "nothing measured yet".
 */
export interface MetricsFigure {
  last: number;
  average: number;
}

/**
 * Props for {@link TranslationMetricsCard}.
 */
export interface TranslationMetricsCardProps {
  // Translator status, already in display form (e.g. "ready", "off").
  statusLabel: string;
  // Time captions spent queued before their translate() call started.
  wait: MetricsFigure;
  // Duration of the translate() call itself.
  translate: MetricsFigure;
  // Queue wait plus call: how stale a caption was when it reached the screen.
  total: MetricsFigure;
  // Captions still queued when the last measurement was taken.
  queuedCaptions: number;
  // Captions dropped to keep up, or lost to a failed translation.
  droppedCaptions: number;
  // How many translate() calls have been measured.
  sampleCount: number;
}

/**
 * In-browser translation timing, in milliseconds: rows are the legs of the
 * path, columns are the newest sample and its moving average.
 *
 * - "Wait" is queue time - how long the caption sat before the model got to it.
 *   It grows when translation cannot keep pace with the room.
 * - "Translate" is the model call itself. It grows when individual calls slow
 *   down, which is a different problem with a different fix.
 * - "Total" is their sum: how stale a caption was when its translation reached
 *   the screen.
 *
 * Unlike transcription latency this is measured entirely in the browser -
 * translation never leaves the device - so there is no clock skew to correct
 * and no interim/final split: only finalized captions are translated.
 *
 * Always renders, even with no samples, so an overlay switched on while
 * translation is off says so rather than vanishing.
 */
export const TranslationMetricsCard = ({
  statusLabel,
  wait,
  translate,
  total,
  queuedCaptions,
  droppedCaptions,
  sampleCount,
}: TranslationMetricsCardProps) => {
  const rows = [
    { label: 'Wait', figure: wait },
    { label: 'Translate', figure: translate },
    { label: 'Total', figure: total },
  ];

  return (
    <MetricsCard
      title="Translation"
      tableLabel="Translation latency in milliseconds"
      footer={`${statusLabel} · queued ${queuedCaptions.toString()} · dropped ${droppedCaptions.toString()} · ${sampleCount.toString()} calls`}
    >
      <thead>
        <tr>
          {/* Milliseconds are named once here rather than on every value. */}
          <Box component="th" scope="col" sx={metricHeaderCellSx}>
            ms
          </Box>
          <Box component="th" scope="col" sx={metricHeaderCellSx}>
            Last
          </Box>
          <Box component="th" scope="col" sx={metricHeaderCellSx}>
            Avg
          </Box>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.label}>
            <Box component="th" scope="row" sx={metricHeaderCellSx}>
              {row.label}
            </Box>
            <Box component="td" sx={metricValueCellSx}>
              {formatMs(row.figure.last)}
            </Box>
            <Box component="td" sx={metricValueCellSx}>
              {formatMs(row.figure.average)}
            </Box>
          </tr>
        ))}
      </tbody>
    </MetricsCard>
  );
};
