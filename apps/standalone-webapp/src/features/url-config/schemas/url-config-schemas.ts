import type { TSchema } from 'typebox';
import { Type } from 'typebox';

import { appLayoutPreferencesSchema } from '@scribear/app-layout-store';
import { microphonePreferencesSchema } from '@scribear/microphone-store';
import { themePreferencesSchema } from '@scribear/theme-customization-store';
import { transcriptionDisplayPreferencesSchema } from '@scribear/transcription-display-store';

import { ProviderId } from '#src/features/transcription-providers/services/providers/provider-registry';

const webspeechConfigSchema = Type.Object({
  languageTag: Type.String(),
});

const streamtextConfigSchema = Type.Object({
  event: Type.String(),
  language: Type.String(),
  startPosition: Type.Number(),
});

const providerConfigSchema = Type.Object({
  [ProviderId.WEBSPEECH]: Type.Partial(webspeechConfigSchema),
  [ProviderId.STREAMTEXT]: Type.Partial(streamtextConfigSchema),
});

const providerPreferencesSchema = Type.Object({
  preferredProviderId: Type.Union([
    Type.Literal(ProviderId.WEBSPEECH),
    Type.Literal(ProviderId.STREAMTEXT),
    Type.Null(),
  ]),
});

export const urlConfigSchemas: Record<string, TSchema> = {
  appLayoutPreferences: Type.Partial(appLayoutPreferencesSchema),
  microphonePreferences: Type.Partial(microphonePreferencesSchema),
  themePreferences: Type.Partial(themePreferencesSchema),
  transcriptionDisplayPreferences: Type.Partial(
    transcriptionDisplayPreferencesSchema,
  ),
  providerConfig: Type.Partial(providerConfigSchema),
  providerPreferences: Type.Partial(providerPreferencesSchema),
};
