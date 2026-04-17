import { VISUALIZER_CONFIG } from '../config/visualizer-config.js';

export interface VisualizerBounds {
  actualX: number;
  actualY: number;
  actualWidth: number;
  actualHeight: number;
}

/**
 * Computes the actual visualizer position and size clamped to the viewport.
 *
 * Priority: first shrink width/height to fit the viewport (respecting the
 * configured minimums), then clamp position so the panel stays fully visible.
 */
export function deriveVisualizerPreferences(
  targetX: number,
  targetY: number,
  targetWidth: number,
  targetHeight: number,
  viewportWidth: number,
  viewportHeight: number,
): VisualizerBounds {
  const actualWidth = Math.max(
    VISUALIZER_CONFIG.width.min,
    Math.min(targetWidth, viewportWidth),
  );
  const actualHeight = Math.max(
    VISUALIZER_CONFIG.height.min,
    Math.min(targetHeight, viewportHeight),
  );

  const actualX = Math.max(
    0,
    Math.min(targetX, viewportWidth - actualWidth),
  );
  const actualY = Math.max(
    0,
    Math.min(targetY, viewportHeight - actualHeight),
  );

  return { actualX, actualY, actualWidth, actualHeight };
}
