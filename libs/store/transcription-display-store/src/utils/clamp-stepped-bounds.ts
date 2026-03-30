/**
 * Snaps a value to the nearest step increment, rounds to the specified precision,
 * and clamps the result within the given min/max range.
 * @param value - The raw numeric value to constrain.
 * @param bounds - An object specifying `min`, `max`, `step`, and `precision`.
 * @returns The value rounded to the nearest step and clamped within bounds.
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
 * Like {@link clampRoundedStepBounds}, but biases toward the lower step by
 * subtracting half a step before rounding. Useful when computing a maximum
 * that should not exceed a derived container limit.
 * @param value - The raw numeric value to constrain.
 * @param bounds - An object specifying `min`, `max`, `step`, and `precision`.
 * @returns The value floored to the nearest step and clamped within bounds.
 */
export function clampFloorStepBounds(
  value: number,
  bounds: { min: number; max: number; step: number; precision: number },
) {
  return clampRoundedStepBounds(value - bounds.step / 2, bounds);
}

/**
 * Like {@link clampRoundedStepBounds}, but biases toward the higher step by
 * adding half a step before rounding.
 * @param value - The raw numeric value to constrain.
 * @param bounds - An object specifying `min`, `max`, `step`, and `precision`.
 * @returns The value ceiled to the nearest step and clamped within bounds.
 */
export function clampCeilStepBounds(
  value: number,
  bounds: { min: number; max: number; step: number; precision: number },
) {
  return clampRoundedStepBounds(value + bounds.step / 2, bounds);
}
