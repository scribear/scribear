import type { TSchema } from 'typebox';
import { Type } from 'typebox';

import { appLayoutPreferencesSchema } from '@scribear/app-layout-store';
import { microphonePreferencesSchema } from '@scribear/microphone-store';
import { themePreferencesSchema } from '@scribear/theme-customization-store';
import { transcriptionDisplayPreferencesSchema } from '@scribear/transcription-display-store';

const splitScreenPreferencesSchema = Type.Object({
  targetRightPanelWidthPercent: Type.Number(),
  isRightPanelOpen: Type.Boolean(),
});

export const urlConfigSchemas: Record<string, TSchema> = {
  appLayoutPreferences: Type.Partial(appLayoutPreferencesSchema),
  microphonePreferences: Type.Partial(microphonePreferencesSchema),
  themePreferences: Type.Partial(themePreferencesSchema),
  transcriptionDisplayPreferences: Type.Partial(
    transcriptionDisplayPreferencesSchema,
  ),
  splitScreenPreferences: Type.Partial(splitScreenPreferencesSchema),
};
