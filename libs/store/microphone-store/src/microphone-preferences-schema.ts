import { Type } from 'typebox';

/**
 * Typebox schema for the microphone preferences slice state.
 * Used for URL config validation.
 */
export const microphonePreferencesSchema = Type.Object({
  isPreferMicrophoneActive: Type.Boolean(),
});
