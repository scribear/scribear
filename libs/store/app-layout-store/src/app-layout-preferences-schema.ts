import { Type } from 'typebox';

/**
 * Typebox schema for the app layout preferences slice state.
 * Used for URL config validation.
 */
export const appLayoutPreferencesSchema = Type.Object({
  isHeaderHideEnabled: Type.Boolean(),
});
