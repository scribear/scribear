/**
 * Rounds value to nearest step and clamps result to bounds
 */
export function clampRoundedStepBounds(
  value: number,
  {
    min,
    max,
    step,
    precision,
  }: { min: number; max: number; step: number; precision: number },
) {
  value = Math.round(value / step) * step;
  value = Number(value.toFixed(precision));
  return Math.min(Math.max(min, value), max);
}

/**
 * Rounds down value to nearest step and clamps result to bounds
 */
export function clampFloorStepBounds(
  value: number,
  {
    min,
    max,
    step,
    precision,
  }: { min: number; max: number; step: number; precision: number },
) {
  return clampRoundedStepBounds(value - step / 2, {
    min,
    max,
    step,
    precision,
  });
}

/**
 * Rounds up value to nearest step and clamps result to bounds
 */
export function clampCeilStepBounds(
  value: number,
  {
    min,
    max,
    step,
    precision,
  }: { min: number; max: number; step: number; precision: number },
) {
  return clampRoundedStepBounds(value + step / 2, {
    min,
    max,
    step,
    precision,
  });
}
