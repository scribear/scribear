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
 * Assumed speaking rate, in words/second, used to derive how long each line
 * of the fixture is "spoken" for. The wire caption schema has no speaker
 * field, so speaker identity is tracked alongside the schedule for future use
 * (e.g. logging) but is never folded into caption text - a demo-only
 * convention.
 */
export const DEMO_WORDS_PER_SECOND = 5;

/** Gap between consecutive lines within the same speaker's turn. */
export const DEMO_GAP_WITHIN_TURN_SECONDS = 0.3;

/** Gap inserted when the speaker changes. */
export const DEMO_GAP_BETWEEN_TURNS_SECONDS = 0.8;

/**
 * How often an in-progress caption update is published while a line is being
 * "spoken", so a viewer sees the partial sentence grow roughly once a second
 * rather than a single interim guess at the midpoint.
 */
export const DEMO_INTERIM_INTERVAL_SECONDS = 1;
