export const VISUALIZER_CONFIG = {
  width: { min: 200, step: 1, precision: 0 },
  height: { min: 150, step: 1, precision: 0 },
  position: { min: 0, step: 1, precision: 0 },
} as const;

export const VISUALIZER_DEFAULTS = {
  targetX: 16,
  targetY: 16,
  targetWidth: 340,
  targetHeight: 420,
} as const;
