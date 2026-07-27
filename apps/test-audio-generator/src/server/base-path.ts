/**
 * Base path for every route this service serves.
 *
 * The generator sits on the `backend` compose network only and is deliberately
 * **not** proxied by nginx: it holds two long-lived device tokens, and its
 * control API can point a synthetic source at a live room. Its only intended
 * caller is admin-server's test-audio BFF, which already holds admin auth and
 * audits every mutation. The versioned prefix matches the convention every
 * other Node service uses, and is the path `TestAudioGatewayService` builds.
 */
export const TEST_AUDIO_BASE_PATH = '/api/test-audio/v1';
