import { useCallback } from 'react';

import Box from '@mui/material/Box';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import { useTheme } from '@mui/material/styles';

import { VISUALIZER_CONFIG } from '@scribear/visualizer-store';

import { FrequencyVisualizer } from '#src/components/frequency-visualizer.js';
import { MelCepstrumVisualizer } from '#src/components/mel-cepstrum-visualizer.js';
import { TimeSeriesVisualizer } from '#src/components/time-series-visualizer.js';
import { useBoundedVisualizer } from '#src/hooks/use-bounded-visualizer.js';
import { useDrag } from '#src/hooks/use-drag.js';
import { useResize } from '#src/hooks/use-resize.js';

const HEADER_HEIGHT = 36;
const RESIZE_HANDLE_SIZE = 16;
const VIS_LABEL_HEIGHT = 18;

// Pixels moved/resized per arrow-key press on the (keyboard-operable) handles.
const NUDGE_PX = 10;
const ARROW_DELTAS: Record<string, [number, number]> = {
  ArrowLeft: [-NUDGE_PX, 0],
  ArrowRight: [NUDGE_PX, 0],
  ArrowUp: [0, -NUDGE_PX],
  ArrowDown: [0, NUDGE_PX],
};

// A focus-visible ring so the handles show keyboard focus (a bare Box has none).
const HANDLE_FOCUS_SX = {
  '&:focus-visible': {
    outline: '2px solid',
    outlineColor: 'primary.main',
    outlineOffset: '-2px',
  },
} as const;

export interface VisualizerPanelProps {
  analyserNode: AnalyserNode | null;
  frequencyEnabled: boolean;
  timeSeriesEnabled: boolean;
  melCepstrumEnabled: boolean;
  targetX: number;
  targetY: number;
  targetWidth: number;
  targetHeight: number;
  onPositionChange: (x: number, y: number) => void;
  onSizeChange: (width: number, height: number) => void;
}

export const VisualizerPanel = ({
  analyserNode,
  frequencyEnabled,
  timeSeriesEnabled,
  melCepstrumEnabled,
  targetX,
  targetY,
  targetWidth,
  targetHeight,
  onPositionChange,
  onSizeChange,
}: VisualizerPanelProps) => {
  const theme = useTheme();
  const primaryColor = theme.palette.primary.main;

  const { actualX, actualY, actualWidth, actualHeight } = useBoundedVisualizer(
    targetX,
    targetY,
    targetWidth,
    targetHeight,
  );

  const handleDragCommit = useCallback(
    (deltaX: number, deltaY: number) => {
      onPositionChange(targetX + deltaX, targetY + deltaY);
    },
    [onPositionChange, targetX, targetY],
  );

  const handleResizeCommit = useCallback(
    (deltaW: number, deltaH: number) => {
      onSizeChange(targetWidth + deltaW, targetHeight + deltaH);
    },
    [onSizeChange, targetWidth, targetHeight],
  );

  const {
    dragDelta,
    onMouseDown: onDragStart,
    isDragging,
  } = useDrag(handleDragCommit);
  const { resizeDelta, onMouseDown: onResizeStart } =
    useResize(handleResizeCommit);

  // Keyboard equivalents for the mouse-only drag/resize handles. (SC 2.1.1)
  const handleDragKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      const delta = ARROW_DELTAS[event.key];
      if (!delta) return;
      event.preventDefault();
      onPositionChange(targetX + delta[0], targetY + delta[1]);
    },
    [onPositionChange, targetX, targetY],
  );

  const handleResizeKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      const delta = ARROW_DELTAS[event.key];
      if (!delta) return;
      event.preventDefault();
      onSizeChange(targetWidth + delta[0], targetHeight + delta[1]);
    },
    [onSizeChange, targetWidth, targetHeight],
  );

  const visualX = actualX + (dragDelta?.x ?? 0);
  const visualY = actualY + (dragDelta?.y ?? 0);
  const visualWidth = Math.max(
    VISUALIZER_CONFIG.width.min,
    actualWidth + (resizeDelta?.w ?? 0),
  );
  const visualHeight = Math.max(
    VISUALIZER_CONFIG.height.min,
    actualHeight + (resizeDelta?.h ?? 0),
  );

  const activeCount = [
    frequencyEnabled,
    timeSeriesEnabled,
    melCepstrumEnabled,
  ].filter(Boolean).length;
  const contentHeight = visualHeight - HEADER_HEIGHT - RESIZE_HANDLE_SIZE;
  const sectionHeight = activeCount > 0 ? contentHeight / activeCount : 0;
  const canvasHeight = Math.max(1, sectionHeight - VIS_LABEL_HEIGHT);

  return (
    <Paper
      elevation={6}
      sx={{
        position: 'fixed',
        left: visualX,
        top: visualY,
        width: visualWidth,
        height: visualHeight,
        zIndex: 1300,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        userSelect: 'none',
      }}
    >
      {/* Drag handle — mouse drag plus arrow-key move for keyboard users. */}
      <Box
        role="button"
        tabIndex={0}
        aria-label="Move visualizer (use arrow keys)"
        onMouseDown={onDragStart}
        onKeyDown={handleDragKeyDown}
        sx={{
          height: HEADER_HEIGHT,
          display: 'flex',
          alignItems: 'center',
          px: 1,
          gap: 0.5,
          cursor: isDragging ? 'grabbing' : 'grab',
          borderBottom: 1,
          borderColor: 'divider',
          flexShrink: 0,
          ...HANDLE_FOCUS_SX,
        }}
      >
        <Box
          sx={{
            display: 'flex',
            flexDirection: 'column',
            gap: '3px',
            px: 0.5,
            opacity: 0.35,
          }}
        >
          {[0, 1, 2].map((row) => (
            <Box key={row} sx={{ display: 'flex', gap: '3px' }}>
              {[0, 1].map((col) => (
                <Box
                  key={col}
                  sx={{
                    width: 3,
                    height: 3,
                    borderRadius: '50%',
                    bgcolor: 'text.primary',
                  }}
                />
              ))}
            </Box>
          ))}
        </Box>
        <Typography
          variant="caption"
          sx={{ flex: 1, opacity: 0.6, fontSize: 11 }}
        >
          Visualizer
        </Typography>
      </Box>

      {/* Visualizer sections */}
      <Box
        sx={{
          flex: 1,
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {frequencyEnabled && (
          <Box
            sx={{ height: sectionHeight, flexShrink: 0, overflow: 'hidden' }}
          >
            <Typography
              variant="caption"
              sx={{
                display: 'block',
                px: 1,
                opacity: 0.5,
                fontSize: 10,
                lineHeight: `${VIS_LABEL_HEIGHT.toString()}px`,
              }}
            >
              Frequency
            </Typography>
            <FrequencyVisualizer
              analyserNode={analyserNode}
              width={visualWidth}
              height={canvasHeight}
              color={primaryColor}
            />
          </Box>
        )}
        {timeSeriesEnabled && (
          <Box
            sx={{ height: sectionHeight, flexShrink: 0, overflow: 'hidden' }}
          >
            <Typography
              variant="caption"
              sx={{
                display: 'block',
                px: 1,
                opacity: 0.5,
                fontSize: 10,
                lineHeight: `${VIS_LABEL_HEIGHT.toString()}px`,
              }}
            >
              Waveform
            </Typography>
            <TimeSeriesVisualizer
              analyserNode={analyserNode}
              width={visualWidth}
              height={canvasHeight}
              color={primaryColor}
            />
          </Box>
        )}
        {melCepstrumEnabled && (
          <Box
            sx={{ height: sectionHeight, flexShrink: 0, overflow: 'hidden' }}
          >
            <Typography
              variant="caption"
              sx={{
                display: 'block',
                px: 1,
                opacity: 0.5,
                fontSize: 10,
                lineHeight: `${VIS_LABEL_HEIGHT.toString()}px`,
              }}
            >
              Mel Cepstrum
            </Typography>
            <MelCepstrumVisualizer
              analyserNode={analyserNode}
              width={visualWidth}
              height={canvasHeight}
              color={primaryColor}
            />
          </Box>
        )}
      </Box>

      {/* Resize handle — mouse drag plus arrow-key resize for keyboard users. */}
      <Box
        role="button"
        tabIndex={0}
        aria-label="Resize visualizer (use arrow keys)"
        onMouseDown={onResizeStart}
        onKeyDown={handleResizeKeyDown}
        sx={{
          position: 'absolute',
          bottom: 0,
          right: 0,
          width: RESIZE_HANDLE_SIZE,
          height: RESIZE_HANDLE_SIZE,
          cursor: 'nwse-resize',
          display: 'flex',
          alignItems: 'flex-end',
          justifyContent: 'flex-end',
          p: '3px',
          opacity: 0.3,
          color: 'text.primary',
          '&:hover': { opacity: 0.8 },
          ...HANDLE_FOCUS_SX,
        }}
      >
        <svg width={10} height={10} viewBox="0 0 10 10">
          <line
            x1="2"
            y1="10"
            x2="10"
            y2="2"
            stroke="currentColor"
            strokeWidth="1.5"
          />
          <line
            x1="6"
            y1="10"
            x2="10"
            y2="6"
            stroke="currentColor"
            strokeWidth="1.5"
          />
        </svg>
      </Box>
    </Paper>
  );
};
