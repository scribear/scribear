import { Type } from 'typebox';

/**
 * Typebox schema for the theme preferences slice state.
 * Used for URL config validation.
 */
export const themePreferencesSchema = Type.Object({
  backgroundColor: Type.String(),
  accentColor: Type.String(),
  transcriptionColor: Type.String(),
});
