import type { TSchema } from 'typebox';
import { Type } from 'typebox';

import { appLayoutPreferencesSchema } from '@scribear/app-layout-store';
import { microphonePreferencesSchema } from '@scribear/microphone-store';
import { themePreferencesSchema } from '@scribear/theme-customization-store';
import { transcriptionDisplayPreferencesSchema } from '@scribear/transcription-display-store';

const kioskConfigSchema = Type.Object({
  deviceName: Type.Union([Type.String(), Type.Null()]),
  activeSessionId: Type.Union([Type.String(), Type.Null()]),
  prevEventId: Type.Number(),
  sessionRefreshToken: Type.Union([Type.String(), Type.Null()]),
});

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
  kioskConfig: Type.Partial(kioskConfigSchema),
  splitScreenPreferences: Type.Partial(splitScreenPreferencesSchema),
};
