import { useCallback } from 'react';

import {
  selectEnabledVisualizers,
  selectVisualizerTargetHeight,
  selectVisualizerTargetWidth,
  selectVisualizerTargetX,
  selectVisualizerTargetY,
  setVisualizerPosition,
  setVisualizerSize,
} from '@scribear/visualizer-store';
import { VisualizerPanel } from '@scribear/visualizer-ui';

import { useAppDispatch, useAppSelector } from '#src/store/use-redux';

import { useVisualizerAnalyser } from '../hooks/use-visualizer-analyser';

export const VisualizerContainer = () => {
  const dispatch = useAppDispatch();
  const analyserNode = useVisualizerAnalyser();

  const enabledVisualizers = useAppSelector(selectEnabledVisualizers);
  const targetX = useAppSelector(selectVisualizerTargetX);
  const targetY = useAppSelector(selectVisualizerTargetY);
  const targetWidth = useAppSelector(selectVisualizerTargetWidth);
  const targetHeight = useAppSelector(selectVisualizerTargetHeight);

  const onPositionChange = useCallback(
    (x: number, y: number) => dispatch(setVisualizerPosition({ x, y })),
    [dispatch],
  );
  const onSizeChange = useCallback(
    (width: number, height: number) =>
      dispatch(setVisualizerSize({ width, height })),
    [dispatch],
  );

  return (
    <VisualizerPanel
      analyserNode={analyserNode}
      frequencyEnabled={enabledVisualizers.frequency}
      timeSeriesEnabled={enabledVisualizers.timeSeries}
      melCepstrumEnabled={enabledVisualizers.melCepstrum}
      targetX={targetX}
      targetY={targetY}
      targetWidth={targetWidth}
      targetHeight={targetHeight}
      onPositionChange={onPositionChange}
      onSizeChange={onSizeChange}
    />
  );
};
