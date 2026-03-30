import { TRANSCRIPTION_DISPLAY_CONFG } from '../config/transcription-display-bounds.js';
import { clampFloorStepBounds } from './clamp-stepped-bounds.js';

/**
 * Computes the actual `numDisplayLines` and `verticalPositionPx` values that
 * fit within the available container height, reducing from the user's targets
 * when the container is too small to accommodate both simultaneously.
 *
 * Priority order: first try to fit the target display lines, then adjust the
 * vertical position if necessary to ensure at least one line is visible.
 *
 * @param lineHeightPx - The rendered height of a single line in pixels.
 * @param targetVerticalPositionPx - The user's preferred vertical offset from the top.
 * @param targetDisplayLines - The user's preferred number of visible lines.
 * @param containerHeightPx - The total available height of the display container.
 * @returns An object with the bounded `numDisplayLines` and `verticalPositionPx`.
 */
export function deriveDisplayPreferences(
  lineHeightPx: number,
  targetVerticalPositionPx: number,
  targetDisplayLines: number,
  containerHeightPx: number,
) {
  let numDisplayLines = targetDisplayLines;
  let verticalPositionPx = targetVerticalPositionPx;

  const containerMaxLines =
    (containerHeightPx - verticalPositionPx) / lineHeightPx;
  if (targetDisplayLines <= containerMaxLines) {
    return { numDisplayLines, verticalPositionPx };
  }

  numDisplayLines = clampFloorStepBounds(
    containerMaxLines,
    TRANSCRIPTION_DISPLAY_CONFG.displayLines,
  );

  const containerMaxVerticalPositionPx =
    containerHeightPx - numDisplayLines * lineHeightPx;
  if (verticalPositionPx <= containerMaxVerticalPositionPx) {
    return { numDisplayLines, verticalPositionPx };
  }

  verticalPositionPx = clampFloorStepBounds(
    containerMaxVerticalPositionPx,
    TRANSCRIPTION_DISPLAY_CONFG.verticalPositionPx,
  );

  return { numDisplayLines, verticalPositionPx };
}
