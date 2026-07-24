import { Box, Typography } from '@mui/material';

import {
  selectFinalE2eLatencyMs,
  selectFinalPipelineLatencyMs,
  selectInProgressE2eLatencyMs,
  selectInProgressPipelineLatencyMs,
} from '@scribear/transcription-content-store';

import { useAppSelector } from '#src/store/use-redux';

/**
 * Render a latency value in whole milliseconds, or an em dash when there is no
 * usable measurement yet (0 or non-finite).
 */
function formatLatency(valueMs: number): string {
  if (!Number.isFinite(valueMs) || valueMs <= 0) return '—';
  return Math.round(valueMs).toString();
}

/**
 * Small unobtrusive overlay showing the moving-average transcription latency.
 * Two figures per row: finalized / interim transcripts.
 *
 * - "Pipeline" is the skew-free server-side latency (audio ingress to
 *   transcript) and appears as soon as transcripts flow.
 * - "End-to-end" additionally includes capture and uplink; it appears once the
 *   source device's clock has been synced, and shows an em dash until then.
 */
export const LatencyBadge = () => {
  const pipelineFinal = useAppSelector(selectFinalPipelineLatencyMs);
  const pipelineInterim = useAppSelector(selectInProgressPipelineLatencyMs);
  const e2eFinal = useAppSelector(selectFinalE2eLatencyMs);
  const e2eInterim = useAppSelector(selectInProgressE2eLatencyMs);

  // Nothing measured yet - stay out of the way entirely.
  if (pipelineFinal <= 0 && pipelineInterim <= 0) return null;

  return (
    <Box
      sx={{
        position: 'fixed',
        top: 8,
        right: 8,
        px: 1,
        py: 0.5,
        borderRadius: 1,
        bgcolor: 'rgba(0, 0, 0, 0.6)',
        color: 'common.white',
        pointerEvents: 'none',
        zIndex: (theme) => theme.zIndex.tooltip,
        fontVariantNumeric: 'tabular-nums',
      }}
    >
      <Typography variant="caption" component="div">
        Pipeline: {formatLatency(pipelineFinal)} /{' '}
        {formatLatency(pipelineInterim)} ms
      </Typography>
      <Typography variant="caption" component="div">
        End-to-end: {formatLatency(e2eFinal)} / {formatLatency(e2eInterim)} ms
      </Typography>
    </Box>
  );
};
