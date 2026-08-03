/**
 * Session Manager-side constants for the seeded monitoring canary room.
 *
 * The uids themselves are API contract — the monitoring sidecar derives its
 * credential against them and room-management refuses to reassign the device
 * that carries them — so they live in the shared schema package and are
 * re-exported here for the seeder and the guards, exactly as the demo room's and
 * the test-audio rooms' uids are.
 */
import {
  CANARY_DEVICE_NAME,
  CANARY_DEVICE_UID,
  CANARY_ROOM_NAME,
  CANARY_ROOM_UID,
  CANARY_SESSION_UID,
} from '@scribear/session-manager-schema';

export {
  CANARY_DEVICE_NAME,
  CANARY_DEVICE_UID,
  CANARY_ROOM_NAME,
  CANARY_ROOM_UID,
  CANARY_SESSION_UID,
};

/** Name recorded on the seeded standing session row. */
export const CANARY_SESSION_NAME = 'Monitoring canary';

/**
 * Timezone of the seeded room.
 *
 * UTC, for the same reason the test-audio rooms are UTC: nothing about this room
 * is scheduled, the session is standing and open-ended, and no local time of day
 * is ever evaluated for it. UTC says "there is no local day here" rather than
 * quietly implying a campus.
 */
export const CANARY_ROOM_TIMEZONE = 'UTC';

/**
 * Transcription provider recorded on the seeded session.
 *
 * The canary carries *real* audio and scores the captions that come back, so —
 * unlike the demo caption room, whose captions are fabricated by the Node Server
 * and never reach a provider — this session must name a provider that will
 * actually transcribe it, or the canary measures nothing. `whisper` is the id
 * every shipped `provider_config*.json` defines.
 *
 * Its stream config is empty for the same reason the test-audio sessions' is:
 * the `whisper-streaming` provider is hard-wired to 16 kHz mono
 * (`whisper_streaming_job.py`), which is exactly what the sidecar's
 * `CANARY_SAMPLE_RATE`/`CANARY_CHANNELS` default to, so there is nothing to
 * agree on in the config itself. That is also why the sidecar's ".env.example"
 * note about matching `transcriptionStreamConfig` no longer names anything an
 * operator has to set: both sides now default to the one rate the provider has.
 */
export const CANARY_TRANSCRIPTION_PROVIDER_ID = 'whisper';
export const CANARY_TRANSCRIPTION_STREAM_CONFIG = {};
