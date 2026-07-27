/**
 * Session Manager-side constants for the two seeded operator test-audio rooms.
 *
 * The uids themselves are API contract — the generator derives its credentials
 * against them and room-management refuses to reassign the devices that carry
 * them — so they live in the shared schema package and are re-exported here for
 * the seeder and the guards, exactly as the demo room's uids are.
 */
import {
  TEST_AUDIO_FAULT_DEVICE_NAME,
  TEST_AUDIO_FAULT_DEVICE_UID,
  TEST_AUDIO_FAULT_ROOM_NAME,
  TEST_AUDIO_FAULT_ROOM_UID,
  TEST_AUDIO_FAULT_SESSION_UID,
  TEST_AUDIO_GOOD_DEVICE_NAME,
  TEST_AUDIO_GOOD_DEVICE_UID,
  TEST_AUDIO_GOOD_ROOM_NAME,
  TEST_AUDIO_GOOD_ROOM_UID,
  TEST_AUDIO_GOOD_SESSION_UID,
} from '@scribear/session-manager-schema/test-audio';

export {
  TEST_AUDIO_FAULT_DEVICE_NAME,
  TEST_AUDIO_FAULT_DEVICE_UID,
  TEST_AUDIO_FAULT_ROOM_NAME,
  TEST_AUDIO_FAULT_ROOM_UID,
  TEST_AUDIO_FAULT_SESSION_UID,
  TEST_AUDIO_GOOD_DEVICE_NAME,
  TEST_AUDIO_GOOD_DEVICE_UID,
  TEST_AUDIO_GOOD_ROOM_NAME,
  TEST_AUDIO_GOOD_ROOM_UID,
  TEST_AUDIO_GOOD_SESSION_UID,
};

/** Name recorded on each seeded standing session row. */
export const TEST_AUDIO_GOOD_SESSION_NAME = 'Test audio — good source';
export const TEST_AUDIO_FAULT_SESSION_NAME = 'Test audio — fault source';

/**
 * Timezone of the seeded rooms.
 *
 * UTC because nothing about these rooms is scheduled: the session is standing
 * and open-ended, so no local-time-of-day is ever evaluated for them. UTC is the
 * value that says "there is no local day here" rather than one that quietly
 * implies a campus.
 */
export const TEST_AUDIO_ROOM_TIMEZONE = 'UTC';

/**
 * Transcription provider recorded on the seeded sessions.
 *
 * Unlike the demo caption room — whose captions are fabricated by the Node
 * Server and never reach a provider — these sessions carry *real* audio and must
 * name a provider that will actually transcribe it, or the feature demonstrates
 * nothing. `whisper` is the id every shipped `provider_config*.json` defines and
 * the default `deployment/create-session.sh` used for the session an operator
 * created here by hand.
 *
 * Its stream config is empty for the same reason that script passed `{}`: the
 * `whisper-streaming` provider is hard-wired to 16 kHz mono
 * (`whisper_streaming_job.py`), which is exactly what the generator's
 * `TEST_AUDIO_SAMPLE_RATE`/`TEST_AUDIO_CHANNELS` default to, so there is nothing
 * to agree on in the config itself.
 */
export const TEST_AUDIO_TRANSCRIPTION_PROVIDER_ID = 'whisper';
export const TEST_AUDIO_TRANSCRIPTION_STREAM_CONFIG = {};

/**
 * The two seeded pairs, in the order the operator's admin page lays the devices
 * out. Everything the seeder needs about one synthetic source, so that adding or
 * renaming one is a single edit and the two can never drift apart.
 */
export const TEST_AUDIO_SEEDS = [
  {
    deviceId: 'good',
    deviceUid: TEST_AUDIO_GOOD_DEVICE_UID,
    deviceName: TEST_AUDIO_GOOD_DEVICE_NAME,
    roomUid: TEST_AUDIO_GOOD_ROOM_UID,
    roomName: TEST_AUDIO_GOOD_ROOM_NAME,
    sessionUid: TEST_AUDIO_GOOD_SESSION_UID,
    sessionName: TEST_AUDIO_GOOD_SESSION_NAME,
  },
  {
    deviceId: 'fault',
    deviceUid: TEST_AUDIO_FAULT_DEVICE_UID,
    deviceName: TEST_AUDIO_FAULT_DEVICE_NAME,
    roomUid: TEST_AUDIO_FAULT_ROOM_UID,
    roomName: TEST_AUDIO_FAULT_ROOM_NAME,
    sessionUid: TEST_AUDIO_FAULT_SESSION_UID,
    sessionName: TEST_AUDIO_FAULT_SESSION_NAME,
  },
] as const;

/** One seeded synthetic source: its device, its room, and its standing session. */
export type TestAudioSeed = (typeof TEST_AUDIO_SEEDS)[number];

/** Every uid the seeder reserves for a source *device*. */
export const TEST_AUDIO_DEVICE_UID_SET: ReadonlySet<string> = new Set(
  TEST_AUDIO_SEEDS.map((seed) => seed.deviceUid),
);

/** Every uid the seeder reserves for a test-audio *room*. */
export const TEST_AUDIO_ROOM_UID_SET: ReadonlySet<string> = new Set(
  TEST_AUDIO_SEEDS.map((seed) => seed.roomUid),
);
