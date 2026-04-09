import { Type } from 'typebox';

/**
 * Typebox schema for the transcription display preferences slice state.
 * Used for URL config validation.
 */
export const transcriptionDisplayPreferencesSchema = Type.Object({
  wordSpacingEm: Type.Number(),
  fontSizePx: Type.Number(),
  lineHeightMultipler: Type.Number(),
  targetVerticalPositionPx: Type.Number(),
  targetDisplayLines: Type.Number(),
});
