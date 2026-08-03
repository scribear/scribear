import { Type } from 'typebox';

/**
 * Typebox schema for the live translation preferences slice state.
 * Used for URL config validation.
 */
export const liveTranslationPreferencesSchema = Type.Object({
  isTranslationEnabled: Type.Boolean(),
  targetLanguage: Type.String(),
});
