import type { TSchema } from 'typebox';
import { Type } from 'typebox';

import { appLayoutPreferencesSchema } from '@scribear/app-layout-store';
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

export const urlConfigSchemas: Record<string, TSchema> = {
  appLayoutPreferences: Type.Partial(appLayoutPreferencesSchema),
  themePreferences: Type.Partial(themePreferencesSchema),
  transcriptionDisplayPreferences: Type.Partial(
    transcriptionDisplayPreferencesSchema,
  ),
  clientSessionConfig: Type.Partial(clientSessionConfigSchema),
};
