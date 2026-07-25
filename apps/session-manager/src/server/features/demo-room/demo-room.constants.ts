/**
 * Fixed identity of the demo caption session.
 *
 * The Session Manager seeds a real, currently-active `ON_DEMAND` session whose
 * `uid` is exactly this value, so a browser can obtain a session token for it
 * through the normal join-code exchange. The Node Server's `DemoCaptionSource`
 * publishes captions on the matching `transcript:${sessionUid}` bus channel
 * (see `apps/node-server/PLAN-Demo-CAPTION_ROOM.md`). The two services are kept
 * in sync by the `DEMO_SESSION_UID` env var, which defaults to this literal on
 * both.
 *
 * `deadbeef` is a memorable, valid hex UUID node; the `4` and `8` nibbles keep
 * it a well-formed v4 UUID.
 */
export const DEFAULT_DEMO_SESSION_UID = 'deadbeef-0000-4000-8000-000000000001';

/**
 * Fixed uid of the demo room's placeholder source device, in the same spirit
 * as {@link DEFAULT_DEMO_SESSION_UID}: seeding by a fixed uid (rather than
 * letting the DB generate one) lets the insert be a genuine
 * `ON CONFLICT (uid) DO NOTHING`, so restarts and racing instances converge
 * on one row instead of each creating their own placeholder device.
 */
export const DEMO_SOURCE_DEVICE_UID = 'deadbeef-0000-4000-8000-000000000002';

/** Fixed uid of the demo room, for the same reason as {@link DEMO_SOURCE_DEVICE_UID}. */
export const DEMO_ROOM_UID = 'deadbeef-0000-4000-8000-000000000003';

/** Display name of the room the demo session lives in. */
export const DEMO_ROOM_NAME = 'Demo — Alice in Wonderland';

/** Name of the placeholder source device created to own the demo room. */
export const DEMO_SOURCE_DEVICE_NAME = 'demo-caption-room-source';

/** Name recorded on the seeded session row. */
export const DEMO_SESSION_NAME = 'Demo — Alice in Wonderland';

/**
 * Transcription provider id recorded on the seeded session. The demo session
 * never dials a real provider - the Node Server's `DemoCaptionSource` publishes
 * captions directly onto the event bus and never opens an upstream connection
 * for this session - so this only needs to be a value the schema accepts.
 * `debug` mirrors the provider id used by the Node Server integration test
 * seeder (`apps/node-server/tests/utils/seed-session.ts`).
 */
export const DEMO_TRANSCRIPTION_PROVIDER_ID = 'debug';

/**
 * Minimal stream config recorded alongside the provider id above; shape
 * mirrors the `debug` provider config used elsewhere in the monorepo's test
 * seeders. Not read by anything at runtime for the demo session.
 */
export const DEMO_TRANSCRIPTION_STREAM_CONFIG = {
  sample_rate: 48_000,
  num_channels: 1,
};
