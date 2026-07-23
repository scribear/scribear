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

const DEPLOYMENT_DOCS_URL =
  'https://github.com/scribear/scribear/wiki/Deployment';

/**
 * The marker every secret in `deployment/.env.example` is stubbed with.
 *
 * Matched as a case-insensitive *substring*, not by equality: only some of the
 * stubs are the bare word. Others carry a suffix that exists purely to satisfy
 * a length rule — `CHANGEME-JWT-must-be-at-least-32-characters-long`,
 * `CHANGEME-admin-session-secret-at-least-32-characters` — and one is embedded
 * in a larger value, `ADMIN_LOCAL_CREDENTIALS=engrit CHANGEME`. An equality
 * check passes all three, which is exactly backwards: those are the stubs a
 * minimum-length rule was already pushing an operator to keep verbatim.
 *
 * A real high-entropy secret containing this run of eight characters is
 * possible but vanishingly unlikely, and the cost of a false positive is a
 * refused boot with an explanatory message rather than a silent compromise.
 */
const PLACEHOLDER_MARKER = 'CHANGEME';

/** True when `value` is empty or still carries the `.env.example` stub. */
export function isPlaceholderSecret(value: string): boolean {
  return value === '' || value.toUpperCase().includes(PLACEHOLDER_MARKER);
}

/**
 * Guard against shipping a service with an unusable key. Throws so the service
 * refuses to start until a real secret is configured.
 *
 * Empty is rejected as well as the placeholder. An empty configured key is
 * worse than a weak one: `constantTimeEqual` matches it against the empty
 * string a caller presents as `Authorization: Bearer `, so every guard built on
 * it admits an unauthenticated request. Compose substitutes a blank string for
 * an unset variable, so an `.env` predating a newly required key arrives here
 * as empty rather than failing outright.
 *
 * @param key The configured secret value.
 * @param name Human-readable name for the error message (e.g. `ADMIN_API_KEY`).
 */
export function assertNotPlaceholderKey(key: string, name: string): void {
  if (key === '') {
    throw new Error(
      `${name} is empty. An empty key matches the empty credential an unauthenticated caller presents, so it is an auth bypass rather than a closed door. Set a strong, high-entropy secret before starting - see ${DEPLOYMENT_DOCS_URL}.`,
    );
  }
  if (key.toUpperCase().includes(PLACEHOLDER_MARKER)) {
    throw new Error(
      `${name} still contains the placeholder "${PLACEHOLDER_MARKER}" from deployment/.env.example. Set a strong, high-entropy secret before starting - see ${DEPLOYMENT_DOCS_URL}.`,
    );
  }
}
