/**
 * Error thrown by the admin API client for any non-ok response. Carries the
 * BFF envelope's `code`/`message`/`requestId` plus the HTTP status so callers
 * can branch (e.g. 409 conflict guidance, 502 backend misconfiguration).
 */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly requestId: string | undefined;
  /** The envelope's `error.details`, when the server sent any. */
  readonly details: Record<string, unknown> | undefined;

  constructor(
    code: string,
    message: string,
    status: number,
    requestId?: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.requestId = requestId;
    this.details = details;
  }
}

/** True when the error is an ApiError with the given code. */
export function isApiErrorCode(err: unknown, code: string): boolean {
  return err instanceof ApiError && err.code === code;
}

/**
 * How a failure should be rendered. Follows the house convention: `warning` =
 * degraded or transient, no operator action required beyond waiting; `error` =
 * terminal, the operator has to do something.
 */
export type ErrorSeverity = 'error' | 'warning';

/**
 * True for a 429 from the admin BFF. admin-server registers
 * `@fastify/rate-limit` with `global: true`, so **every** admin route can
 * answer 429 — this is not a per-route special case, and any surface that
 * renders an API failure has to be able to hit it.
 */
export function isRateLimited(err: unknown): boolean {
  return err instanceof ApiError && err.status === 429;
}

/**
 * The wait the limiter reported, as display copy ("1 minute", "45 seconds"),
 * or null when the server did not say. Comes from `error.details.retryAfter`
 * rather than the `Retry-After` header: `AdminApiClient` returns only status
 * and body, so no caller in this app can read a response header.
 */
function retryAfterText(err: unknown): string | null {
  if (!(err instanceof ApiError)) return null;
  const after = err.details?.['retryAfter'];
  return typeof after === 'string' && after !== '' ? after : null;
}

/**
 * Copy for a rate-limited request. `kind` picks the audience: `'sign-in'` is
 * the login form, where the operator's next guess is that their password is
 * wrong and it is important to say that it is not.
 *
 * Both variants name the cause, say nothing was changed (the limiter rejects
 * on `onRequest`, before any handler runs, so no admin mutation ever
 * half-applied), and give the one next action there is — wait, then retry.
 * Nothing in this app auto-retries, so the wording must not imply it will.
 */
export function rateLimitMessage(
  err: unknown,
  kind: 'request' | 'sign-in' = 'request',
): string {
  const wait = retryAfterText(err) ?? 'a moment';
  return kind === 'sign-in'
    ? `Too many sign-in attempts. This is a rate limit, not a rejected password — wait ${wait}, then sign in again.`
    : `Too many requests — the admin server is rate limiting this browser. Nothing was changed; wait ${wait}, then try again.`;
}

/**
 * The message to show for a failed admin API call. Shared by every admin page:
 * this used to be copy-pasted into nine of them, which is why a 429 was
 * rendered nowhere despite being reachable everywhere.
 */
export function errorMessage(err: unknown, fallback: string): string {
  if (isRateLimited(err)) return rateLimitMessage(err);
  return err instanceof ApiError ? err.message : fallback;
}

/** As {@link errorMessage}, but for the login form's audience. */
export function loginErrorMessage(err: unknown): string {
  if (isRateLimited(err)) return rateLimitMessage(err, 'sign-in');
  return err instanceof ApiError
    ? err.message
    : 'Sign in failed. Please try again.';
}

/**
 * Severity to render {@link errorMessage} at. A rate limit is transient and
 * clears on its own, so it is a `warning`; everything else needs the operator
 * to act and stays an `error`.
 */
export function errorSeverity(err: unknown): ErrorSeverity {
  return isRateLimited(err) ? 'warning' : 'error';
}
