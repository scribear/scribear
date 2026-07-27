import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const BEARER_PREFIX = 'Bearer ';

/**
 * Per-process random key. HMAC-ing both operands to a fixed 32-byte digest
 * before `timingSafeEqual` makes the comparison constant-time regardless of
 * input length, unable to throw on a length mismatch, and unable to leak the
 * configured key's length through timing.
 */
const HMAC_KEY = randomBytes(32);

const DEPLOYMENT_DOCS_URL =
  'https://github.com/scribear/scribear/wiki/Deployment';

/** The marker every secret in `deployment/.env.example` is stubbed with. */
const PLACEHOLDER_MARKER = 'CHANGEME';

export interface ServiceAuthConfig {
  serviceKey: string;
}

/**
 * Validates the inbound `TEST_AUDIO_SERVICE_KEY` on every control route.
 *
 * This is the only thing standing between a caller on the `backend` network and
 * the ability to point a synthetic audio source at a live room. Its intended
 * caller is admin-server's test-audio BFF, which holds the key server-side and
 * injects it itself; the operator's browser never sees it and never supplies
 * one.
 *
 * A copy of node-server's `ServiceAuthService` rather than an import: that one
 * is internal to that app, and a shared auth lib for two ten-line classes would
 * be a worse trade than the duplication. If a third appears, extract it.
 */
export class ServiceAuthService {
  private _serviceKey: string;

  constructor(serviceAuthConfig: ServiceAuthConfig) {
    assertUsableServiceKey(serviceAuthConfig.serviceKey);
    this._serviceKey = serviceAuthConfig.serviceKey;
  }

  /** Strips `Bearer ` and compares the rest to the configured key. */
  isValid(authorizationHeader: string | undefined): boolean {
    if (!authorizationHeader?.startsWith(BEARER_PREFIX)) return false;
    return constantTimeEqual(
      authorizationHeader.slice(BEARER_PREFIX.length),
      this._serviceKey,
    );
  }
}

function constantTimeEqual(a: string, b: string): boolean {
  const da = createHmac('sha256', HMAC_KEY).update(a, 'utf8').digest();
  const db = createHmac('sha256', HMAC_KEY).update(b, 'utf8').digest();
  return timingSafeEqual(da, db);
}

/**
 * Refuses to start on an unusable key.
 *
 * Empty is the dangerous case and the likely one: compose substitutes a blank
 * string for an unset variable, and a blank configured key matches the empty
 * credential an unauthenticated caller presents as `Authorization: Bearer `.
 * That is an auth bypass on a service that can put audio into a live lecture,
 * so it fails closed and loudly rather than admitting everyone quietly.
 */
export function assertUsableServiceKey(key: string): void {
  if (key === '') {
    throw new Error(
      'TEST_AUDIO_SERVICE_KEY is empty. An empty key matches the empty credential an unauthenticated caller presents, so it would admit anyone on the backend network to a service that can stream audio into a live room. Set a strong, high-entropy secret before starting - see ' +
        DEPLOYMENT_DOCS_URL +
        '.',
    );
  }
  if (key.toUpperCase().includes(PLACEHOLDER_MARKER)) {
    throw new Error(
      `TEST_AUDIO_SERVICE_KEY still contains the placeholder "${PLACEHOLDER_MARKER}" from deployment/.env.example. Set a strong, high-entropy secret before starting - see ${DEPLOYMENT_DOCS_URL}.`,
    );
  }
}
