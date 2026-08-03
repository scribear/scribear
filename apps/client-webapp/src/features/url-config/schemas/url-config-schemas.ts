import type { TSchema } from 'typebox';
import { Type } from 'typebox';

import { appLayoutPreferencesSchema } from '@scribear/app-layout-store';
import { liveTranslationPreferencesSchema } from '@scribear/live-translation-store';
import { themePreferencesSchema } from '@scribear/theme-customization-store';
import { transcriptionDisplayPreferencesSchema } from '@scribear/transcription-display-store';

// Only `joinCode` is a valid inbound channel from URL config - it's the
// one-shot value the middleware consumes on load. The session identity
// (sessionUid / sessionRefreshToken / clientId) is issued by the server and
// must never be settable from a URL, or a crafted link could pre-seed a
// foreign or stale session into localStorage.
const clientSessionConfigSchema = Type.Object({
  joinCode: Type.Union([Type.String(), Type.Null()]),
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
  themePreferences: Type.Partial(themePreferencesSchema),
  transcriptionDisplayPreferences: Type.Partial(
    transcriptionDisplayPreferencesSchema,
  ),
  clientSessionConfig: Type.Partial(clientSessionConfigSchema),
};
