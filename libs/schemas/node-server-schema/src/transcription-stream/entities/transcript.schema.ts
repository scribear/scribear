import { type Static, Type } from 'typebox';

/**
 * One delivery of transcribed text from the upstream provider. `text` holds
 * the words as separate tokens so callers can render at word granularity.
 * `starts` / `ends` are aligned with `text` and carry seconds-from-stream-start
 * timestamps when the provider supplies them; `null` means the provider does
 * not emit per-token timing.
 */
export const TRANSCRIPT_FRAGMENT_SCHEMA = Type.Object(
  {
    text: Type.Array(Type.String()),
    starts: Type.Union([Type.Array(Type.Number()), Type.Null()]),
    ends: Type.Union([Type.Array(Type.Number()), Type.Null()]),
  },
  { $id: 'TranscriptFragment' },
);

export type TranscriptFragment = Static<typeof TRANSCRIPT_FRAGMENT_SCHEMA>;
