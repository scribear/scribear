/**
 * Configuration constants defining the allowed bounds and step increments for
 * each transcription display preference. Used by clamp utilities and reducers
 * to enforce valid ranges when preferences are adjusted.
 */
export const TRANSCRIPTION_DISPLAY_CONFG = {
  wordSpacingEm: {
    min: 0,
    max: 8,
    step: 0.25,
    precision: 2,
  },
  fontSizePx: {
    min: 4,
    max: 256,
    step: 4,
    precision: 0,
  },
  lineHeightMultipler: {
    min: 1,
    max: 4,
    step: 0.1,
    precision: 1,
  },
  verticalPositionPx: {
    min: 0,
    max: Infinity,
    step: 10,
    precision: 0,
  },
  displayLines: {
    min: 1,
    max: Infinity,
    step: 1,
    precision: 0,
  },
} as const;
