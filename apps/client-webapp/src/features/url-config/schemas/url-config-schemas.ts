import type { TSchema } from 'typebox';
import { Type } from 'typebox';

import { appLayoutPreferencesSchema } from '@scribear/app-layout-store';
import { themePreferencesSchema } from '@scribear/theme-customization-store';
import { transcriptionDisplayPreferencesSchema } from '@scribear/transcription-display-store';

const clientSessionConfigSchema = Type.Object({
  sessionId: Type.Union([Type.String(), Type.Null()]),
  sessionRefreshToken: Type.Union([Type.String(), Type.Null()]),
  joinCode: Type.Union([Type.String(), Type.Null()]),
});

export const urlConfigSchemas: Record<string, TSchema> = {
  appLayoutPreferences: Type.Partial(appLayoutPreferencesSchema),
  themePreferences: Type.Partial(themePreferencesSchema),
  transcriptionDisplayPreferences: Type.Partial(
    transcriptionDisplayPreferencesSchema,
  ),
  clientSessionConfig: Type.Partial(clientSessionConfigSchema),
};
