import { Box } from '@mui/material';

import {
  selectIsTranslationSupported,
  selectTranslationCallLatency,
  selectTranslationDroppedCaptions,
  selectTranslationQueuedCaptions,
  selectTranslationSampleCount,
  selectTranslationStatus,
  selectTranslationTotalLatency,
  selectTranslationWaitLatency,
} from '@scribear/live-translation-store';

import { MetricsCard } from '#src/features/metrics-overlay/components/metrics-card';
import {
  formatMs,
  metricHeaderCellSx,
  metricValueCellSx,
} from '#src/features/metrics-overlay/metrics-display';
import { useAppSelector } from '#src/store/use-redux';

/** One measured leg of the translation path. */
interface LatencyRow {
  label: string;
  last: number;
  average: number;
}

/**
 * Timing for in-browser translation, in milliseconds: rows are the legs of the
 * path, columns are the newest sample and its 60-sample moving average.
 *
 * - "Wait" is queue time - how long the caption sat before the model got to it.
 *   It grows when translation cannot keep pace with the room.
 * - "Translate" is the model call itself. It grows when individual calls slow
 *   down, which is a different problem with a different fix.
 * - "Total" is their sum: how stale a caption was when its translation reached
 *   the screen.
 *
 * Unlike transcription latency, this is measured entirely in this browser -
 * translation never leaves the device - so there is no clock skew to correct
 * and no interim/final split: only finalized captions are translated.
 *
 * Rendered whenever this browser can translate at all, even with translation
 * off, so the overlay answers "why is there no data" instead of vanishing.
 */
export const TranslationMetricsBadge = () => {
  const isSupported = useAppSelector(selectIsTranslationSupported);
  const status = useAppSelector(selectTranslationStatus);
  const wait = useAppSelector(selectTranslationWaitLatency);
  const call = useAppSelector(selectTranslationCallLatency);
  const total = useAppSelector(selectTranslationTotalLatency);
  const queuedCaptions = useAppSelector(selectTranslationQueuedCaptions);
  const droppedCaptions = useAppSelector(selectTranslationDroppedCaptions);
  const sampleCount = useAppSelector(selectTranslationSampleCount);

  // No Translator API here - the whole feature is hidden, so its metrics are
  // noise rather than diagnosis.
  if (!isSupported) return null;

  const rows: LatencyRow[] = [
    { label: 'Wait', last: wait.last, average: wait.average },
    { label: 'Translate', last: call.last, average: call.average },
    { label: 'Total', last: total.last, average: total.average },
  ];

  return (
    <MetricsCard
      title="Translation"
      tableLabel="Translation latency in milliseconds"
      footer={`${status.toLowerCase()} · queued ${queuedCaptions.toString()} · dropped ${droppedCaptions.toString()} · ${sampleCount.toString()} calls`}
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
              {formatMs(row.last)}
            </Box>
            <Box component="td" sx={metricValueCellSx}>
              {formatMs(row.average)}
            </Box>
          </tr>
        ))}
      </tbody>
    </MetricsCard>
  );
};
