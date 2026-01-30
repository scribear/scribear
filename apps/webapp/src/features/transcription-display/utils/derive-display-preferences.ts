import { TRANSCRIPTION_DISPLAY_CONFG } from '../config/transcription-display-bounds';
import { clampFloorStepBounds } from './clamp-stepped-bounds';

/**
 * Derive a set of (mostly) valid display preferences given target display preferences and current container height
 * If targeted preferences don't fit in container, in following order
 * - decrease num display lines (bound by configured minimum)
 * - decrease vertical position (bound by configured minimum)
 * If preferences still don't fit in container, don't change font size or line height
 */
export function deriveDisplayPreferences(
  lineHeightPx: number,
  targetVerticalPositionPx: number,
  targetDisplayLines: number,
  containerHeightPx: number,
) {
  let numDisplayLines = targetDisplayLines;
  let verticalPositionPx = targetVerticalPositionPx;

  // Compute the maximum number of lines container can fit
  const containerMaxLines =
    (containerHeightPx - verticalPositionPx) / lineHeightPx;
  if (targetDisplayLines <= containerMaxLines) {
    return { numDisplayLines, verticalPositionPx };
  }

  // Attempt to reduce number of display lines to maximum valid value,
  // but allow invalid if out of configured bounds
  numDisplayLines = clampFloorStepBounds(
    // Floor because we want containerMaxLines to be an upper bound
    containerMaxLines,
    TRANSCRIPTION_DISPLAY_CONFG.displayLines,
  );

  // Compute the maximum vertical position container can fit
  const containerMaxVerticalPositionPx =
    containerHeightPx - numDisplayLines * lineHeightPx;
  if (verticalPositionPx <= containerMaxVerticalPositionPx) {
    return { numDisplayLines, verticalPositionPx };
  }

  // Attempt to reduce vertical position to maximum valid value,
  // but allow invalid if out of configured bounds
  verticalPositionPx = clampFloorStepBounds(
    // Floor because we want containerMaxVerticalPositionPx to be an upper bound
    containerMaxVerticalPositionPx,
    TRANSCRIPTION_DISPLAY_CONFG.verticalPositionPx,
  );

  return { numDisplayLines, verticalPositionPx };
}
