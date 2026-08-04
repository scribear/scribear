import { Box } from '@mui/material';

import {
  selectFinalE2eLatencyMs,
  selectFinalPipelineLatencyMs,
  selectInProgressE2eLatencyMs,
  selectInProgressPipelineLatencyMs,
} from '@scribear/transcription-content-store';

import { MetricsCard } from '#src/features/metrics-overlay/components/metrics-card';
import {
  formatMs,
  metricHeaderCellSx,
  metricValueCellSx,
} from '#src/features/metrics-overlay/metrics-display';
import { useAppSelector } from '#src/store/use-redux';

/**
 * Moving-average transcription latency, as a two-by-two table of milliseconds:
 * rows are where the stopwatch starts, columns are which transcript was
 * measured.
 *
 * - "Pipeline" is the skew-free server-side latency (audio ingress to
 *   transcript) and appears as soon as transcripts flow.
 * - "End-To-End" additionally includes capture and uplink; it appears once the
 *   source device's clock has been synced, and shows an em dash until then.
 * - "Final" is the committed transcript, "Interim" the provisional text that is
 *   still being revised.
 *
 * Positioned by the metrics overlay that renders it, not by itself.
 */
export const LatencyBadge = () => {
  const pipelineFinal = useAppSelector(selectFinalPipelineLatencyMs);
  const pipelineInterim = useAppSelector(selectInProgressPipelineLatencyMs);
  const e2eFinal = useAppSelector(selectFinalE2eLatencyMs);
  const e2eInterim = useAppSelector(selectInProgressE2eLatencyMs);

  // Nothing measured yet - stay out of the way entirely.
  if (pipelineFinal <= 0 && pipelineInterim <= 0) return null;

  return (
    <MetricsCard
      title="Transcription"
      tableLabel="Transcription latency in milliseconds"
    >
      <thead>
        <tr>
          {/* Milliseconds are named once here rather than on all four values. */}
          <Box component="th" scope="col" sx={metricHeaderCellSx}>
            ms
          </Box>
          <Box component="th" scope="col" sx={metricHeaderCellSx}>
            Final
          </Box>
          <Box component="th" scope="col" sx={metricHeaderCellSx}>
            Interim
          </Box>
        </tr>
      </thead>
      <tbody>
        <tr>
          <Box component="th" scope="row" sx={metricHeaderCellSx}>
            Pipeline
          </Box>
          <Box component="td" sx={metricValueCellSx}>
            {formatMs(pipelineFinal)}
          </Box>
          <Box component="td" sx={metricValueCellSx}>
            {formatMs(pipelineInterim)}
          </Box>
        </tr>
        <tr>
          <Box component="th" scope="row" sx={metricHeaderCellSx}>
            End-To-End
          </Box>
          <Box component="td" sx={metricValueCellSx}>
            {formatMs(e2eFinal)}
          </Box>
          <Box component="td" sx={metricValueCellSx}>
            {formatMs(e2eInterim)}
          </Box>
        </tr>
      </tbody>
    </MetricsCard>
  );
};
