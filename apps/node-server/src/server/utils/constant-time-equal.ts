import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// Per-process random key. HMAC-ing both operands to a fixed 32-byte digest
// before `timingSafeEqual` means the comparison is constant-time regardless of
// input length and can never throw on a length mismatch — and the raw secret
// length is not observable via timing.
const HMAC_KEY = randomBytes(32);

/**
 * Constant-time string equality. Use for comparing a presented credential to a
 * configured secret so an attacker cannot recover the secret byte-by-byte from
 * response timing.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const da = createHmac('sha256', HMAC_KEY).update(a, 'utf8').digest();
  const db = createHmac('sha256', HMAC_KEY).update(b, 'utf8').digest();
  return timingSafeEqual(da, db);
}

/**
 * Guard against shipping a service with the literal placeholder key. Throws so
 * the service refuses to start until a real secret is configured.
 *
 * @param key The configured secret value.
 * @param name Human-readable name for the error message (e.g. `ADMIN_API_KEY`).
 */
export function assertNotPlaceholderKey(key: string, name: string): void {
  if (key === 'CHANGEME') {
    throw new Error(
      `${name} is still set to the placeholder "CHANGEME". Set a strong, high-entropy secret before starting.`,
    );
  }
}
