import type { TSchema } from 'typebox';
import { Type } from 'typebox';

import { appLayoutPreferencesSchema } from '@scribear/app-layout-store';
import { liveTranslationPreferencesSchema } from '@scribear/live-translation-store';
import { microphonePreferencesSchema } from '@scribear/microphone-store';
import { themePreferencesSchema } from '@scribear/theme-customization-store';
import { transcriptionDisplayPreferencesSchema } from '@scribear/transcription-display-store';

const splitScreenPreferencesSchema = Type.Object({
  targetRightPanelWidthPercent: Type.Number(),
  isRightPanelOpen: Type.Boolean(),
});

// Only the target language is settable from a URL. `isTranslationEnabled` is
// deliberately excluded: turning machine translation on is gated behind a
// confirmation that names the download cost and states the output may be
// wrong, and a link must not be able to skip that on a reader's behalf.
const urlConfigurableTranslationSchema = Type.Pick(
  liveTranslationPreferencesSchema,
  ['targetLanguage'],
);

export const urlConfigSchemas: Record<string, TSchema> = {
  appLayoutPreferences: Type.Partial(appLayoutPreferencesSchema),
  liveTranslationPreferences: Type.Partial(urlConfigurableTranslationSchema),
  microphonePreferences: Type.Partial(microphonePreferencesSchema),
  themePreferences: Type.Partial(themePreferencesSchema),
  transcriptionDisplayPreferences: Type.Partial(
    transcriptionDisplayPreferencesSchema,
  ),
  splitScreenPreferences: Type.Partial(splitScreenPreferencesSchema),
};
