import { createHmac } from 'node:crypto';

/**
 * The one derivation both sides of the test-audio feature use.
 *
 * The Session Manager seeds `bcrypt(deriveTestAudioDeviceSecret(...))` as each
 * seeded device's stored credential; the generator derives the very same secret
 * and presents `{deviceUid}:{secret}` as its `DEVICE_TOKEN` cookie. Neither ever
 * transmits a credential to the other — they agree because they compute the same
 * function of the same two inputs.
 *
 * It lives here, in the shared schema package, and is imported by both, rather
 * than being implemented twice. Two independent implementations of "the same"
 * derivation is the class of bug this branch has already spent a commit fixing:
 * a mismatch is invisible until a device fails to authenticate, and looks
 * exactly like a wrong secret.
 *
 * NODE ONLY. Reached through the `@scribear/session-manager-schema/test-audio`
 * subpath rather than the package index deliberately: the index is imported by
 * the browser bundles (admin-webapp, kiosk-webapp), and `node:crypto` in that
 * graph would break their build. Nothing in a browser needs to derive a device
 * credential.
 */

/** Separator in a `DEVICE_TOKEN` value; must match `DeviceAuthService.encode`. */
const TOKEN_SEPARATOR = ':';

/**
 * Derives one device's plaintext secret from the deployment-wide test-audio
 * secret and that device's fixed uid.
 *
 * HMAC-SHA256 keyed on the deployment secret, over the device uid. HMAC rather
 * than a hash of the concatenation so that the two devices' secrets are
 * independent: learning one (say, from a generator's environment) says nothing
 * about the other, and neither says anything about the root secret.
 *
 * base64url-encoded, so the result is 43 characters — comfortably inside
 * bcrypt's 72-byte input limit, which silently truncates anything longer, and
 * free of the `:` that {@link deriveTestAudioDeviceToken} separates on.
 *
 * @param testAudioSecret The deployment's `TEST_AUDIO_DEVICE_SECRET`.
 * @param deviceUid The device's fixed uid, from `test-audio.constants.ts`.
 */
export function deriveTestAudioDeviceSecret(
  testAudioSecret: string,
  deviceUid: string,
): string {
  return createHmac('sha256', testAudioSecret)
    .update(deviceUid, 'utf8')
    .digest('base64url');
}

/**
 * The full `DEVICE_TOKEN` cookie value for a seeded test-audio device.
 *
 * Exactly the `{deviceUid}:{secret}` shape `DeviceAuthService.encode` produces
 * and `DeviceAuthService.decode` splits, so a derived token is indistinguishable
 * from one minted by `activate-device` — it authenticates through the same
 * `verify()` path, against the same bcrypt hash column, with no special case
 * anywhere in the auth code.
 *
 * @param testAudioSecret The deployment's `TEST_AUDIO_DEVICE_SECRET`.
 * @param deviceUid The device's fixed uid, from `test-audio.constants.ts`.
 */
export function deriveTestAudioDeviceToken(
  testAudioSecret: string,
  deviceUid: string,
): string {
  return `${deviceUid}${TOKEN_SEPARATOR}${deriveTestAudioDeviceSecret(
    testAudioSecret,
    deviceUid,
  )}`;
}
