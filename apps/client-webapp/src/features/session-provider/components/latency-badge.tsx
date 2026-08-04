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

const headerCellSx = {
  px: 0.75,
  py: 0.25,
  fontWeight: 600,
  whiteSpace: 'nowrap',
} as const;

const valueCellSx = {
  px: 0.75,
  py: 0.25,
  textAlign: 'right',
  fontVariantNumeric: 'tabular-nums',
} as const;

/**
 * Small unobtrusive overlay showing the moving-average transcription latency,
 * as a two-by-two table of milliseconds: rows are where the stopwatch starts,
 * columns are which transcript was measured.
 *
 * - "Pipeline" is the skew-free server-side latency (audio ingress to
 *   transcript) and appears as soon as transcripts flow.
 * - "End-To-End" additionally includes capture and uplink; it appears once the
 *   source device's clock has been synced, and shows an em dash until then.
 * - "Final" is the committed transcript, "Interim" the provisional text that is
 *   still being revised.
 *
 * Centered along the top rather than tucked into a corner: the top right is
 * where the header controls live, and the badge would sit over them.
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
        left: '50%',
        transform: 'translateX(-50%)',
        px: 0.5,
        py: 0.5,
        borderRadius: 1,
        bgcolor: 'rgba(0, 0, 0, 0.6)',
        color: 'common.white',
        pointerEvents: 'none',
        zIndex: (theme) => theme.zIndex.tooltip,
      }}
    >
      <Typography
        variant="caption"
        component="table"
        // Milliseconds are named once, in the corner cell, rather than repeated
        // in all four values.
        aria-label="Transcription latency in milliseconds"
        sx={{ borderCollapse: 'collapse' }}
      >
        <thead>
          <tr>
            <Box component="th" scope="col" sx={headerCellSx}>
              ms
            </Box>
            <Box component="th" scope="col" sx={headerCellSx}>
              Final
            </Box>
            <Box component="th" scope="col" sx={headerCellSx}>
              Interim
            </Box>
          </tr>
        </thead>
        <tbody>
          <tr>
            <Box component="th" scope="row" sx={headerCellSx}>
              Pipeline
            </Box>
            <Box component="td" sx={valueCellSx}>
              {formatLatency(pipelineFinal)}
            </Box>
            <Box component="td" sx={valueCellSx}>
              {formatLatency(pipelineInterim)}
            </Box>
          </tr>
          <tr>
            <Box component="th" scope="row" sx={headerCellSx}>
              End-To-End
            </Box>
            <Box component="td" sx={valueCellSx}>
              {formatLatency(e2eFinal)}
            </Box>
            <Box component="td" sx={valueCellSx}>
              {formatLatency(e2eInterim)}
            </Box>
          </tr>
        </tbody>
      </Typography>
    </Box>
  );
};
