import Box from '@mui/material/Box';

import { MetricsCard } from '#src/components/metrics-card.js';
import {
  formatMs,
  metricHeaderCellSx,
  metricValueCellSx,
} from '#src/metrics-display.js';

/**
 * Props for {@link LatencyMetricsCard}. All values are moving averages in
 * milliseconds, and 0 means "nothing measured yet".
 */
export interface LatencyMetricsCardProps {
  // Skew-free node-side latency for finalized transcripts.
  pipelineFinalMs: number;
  // Skew-free node-side latency for interim transcripts.
  pipelineInterimMs: number;
  // Capture-to-screen latency for finalized transcripts; 0 until clock sync.
  e2eFinalMs: number;
  // Capture-to-screen latency for interim transcripts; 0 until clock sync.
  e2eInterimMs: number;
}

/**
 * Transcription latency, as a two-by-two table of milliseconds: rows are where
 * the stopwatch starts, columns are which transcript was measured.
 *
 * - "Pipeline" is the skew-free server-side latency (audio ingress to
 *   transcript) and appears as soon as transcripts flow.
 * - "End-To-End" additionally includes capture and uplink; it appears once the
 *   source device's clock has been synced, and shows an em dash until then.
 * - "Final" is the committed transcript, "Interim" the provisional text that is
 *   still being revised.
 *
 * Renders nothing until something has been measured, so an overlay switched on
 * before a session starts stays out of the way.
 */
export const LatencyMetricsCard = ({
  pipelineFinalMs,
  pipelineInterimMs,
  e2eFinalMs,
  e2eInterimMs,
}: LatencyMetricsCardProps) => {
  if (pipelineFinalMs <= 0 && pipelineInterimMs <= 0) return null;

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
            {formatMs(pipelineFinalMs)}
          </Box>
          <Box component="td" sx={metricValueCellSx}>
            {formatMs(pipelineInterimMs)}
          </Box>
        </tr>
        <tr>
          <Box component="th" scope="row" sx={metricHeaderCellSx}>
            End-To-End
          </Box>
          <Box component="td" sx={metricValueCellSx}>
            {formatMs(e2eFinalMs)}
          </Box>
          <Box component="td" sx={metricValueCellSx}>
            {formatMs(e2eInterimMs)}
          </Box>
        </tr>
      </tbody>
    </MetricsCard>
  );
};
