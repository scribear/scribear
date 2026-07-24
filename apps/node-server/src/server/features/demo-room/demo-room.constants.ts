/**
 * Fixed identity of the demo caption session.
 *
 * The Session Manager seeds a session whose `uid` is exactly this value (see
 * `apps/node-server/PLAN-Demo-CAPTION_ROOM.md`), so a browser can join it
 * through the normal join-code flow, and {@link DemoCaptionSource} publishes
 * captions on the matching `transcript:${sessionUid}` bus channel. The two
 * services are kept in sync by the `DEMO_SESSION_UID` env var, which defaults
 * to this literal on both.
 *
 * `deadbeef` is a memorable, valid hex UUID node; the `4` and `8` nibbles keep
 * it a well-formed v4 UUID so it passes the `format: 'uuid'` param check on the
 * transcription-stream route.
 */
export const DEFAULT_DEMO_SESSION_UID = 'deadbeef-0000-4000-8000-000000000001';

/**
 * Gap after the final utterance of a loop before the fixture restarts, so a
 * viewer perceives a natural pause rather than an instant jump back to the top.
 */
export const DEMO_LOOP_TAIL_GAP_MS = 2_000;

/**
 * Display labels prefixed onto the first token of each speaker turn. The wire
 * caption schema has no speaker field, so speaker identity is carried inside
 * the caption text; this is a demo-only convention. Speakers not listed fall
 * back to a capitalized form of the raw speaker string.
 */
export const DEMO_SPEAKER_LABELS: Record<string, string> = {
  caterpillar: 'Caterpillar',
  alice: 'Alice',
  pigeon: 'Pigeon',
};
