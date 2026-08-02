import { ApiError } from './api-error';

/**
 * A failed request described the way PLAN-VisibleErrors §1 requires: a
 * **cause**, an **audience** (the operator reading this console), and a
 * **next action** — or `null` when we cannot honestly name one, rather than
 * implying a retry that cannot work.
 */
export interface ApiFailure {
  /** What went wrong, in the operator's terms. Never "Something went wrong." */
  cause: string;
  /** What to do about it, or null when no action of the reader's can help. */
  nextAction: string | null;
  /** True when re-issuing the same request could plausibly succeed. */
  retryable: boolean;
  /**
   * admin-server's per-request correlation id, when the failure reached the
   * server. `undefined` for failures that never got a reply (offline, DNS,
   * nginx down) — see {@link describeApiFailure}.
   */
  requestId: string | undefined;
}

// `errorMessage(err, fallback)` deliberately does NOT live here, even though
// this module owns the rest of the failure vocabulary. It lives in
// `api-error.ts`, because the only correct implementation is rate-limit aware
// (a 429 must not render the server's log-facing string), and two copies of it
// briefly existed here — one aware, one not. A page that imported the wrong
// one would silently lose the 429 wording, which is precisely the
// distinct-causes-collapsed-to-one-message mode this module exists to prevent.
// One implementation, in `api-error.ts`; import it from there.

const CHECK_LOGS = 'Retry. If it keeps failing, check the admin server logs';

/**
 * Maps an error thrown by `adminApi` onto a cause / next action pair.
 *
 * The branches mirror what admin-server can actually emit for these routes —
 * verified by reading `session-manager-gateway.service.ts#classify`
 * (`BACKEND_MISCONFIGURATION` 502 / `UPSTREAM_UNREACHABLE` 503 /
 * `UPSTREAM_ERROR` 502 / `RATE_LIMITED` 429), `require-session.hook.ts`
 * (`UNAUTHENTICATED` 401), `require-role.hook.ts` (`FORBIDDEN` 403),
 * `rate-limit.plugin.ts` (a *global* limiter, so any list load can 429),
 * `error-handler.plugin.ts` (`INTERNAL_ERROR` 500), and the two codes
 * `admin-api.ts` mints client-side (`NETWORK`, `INVALID_RESPONSE`).
 * Collapsing those into one "Something went wrong. Retry." would be the
 * distinct-causes-collapsed-to-one-message mode from §0 all over again: an
 * expired session, a rate limit, a dead session-manager and a wrong
 * ADMIN_API_KEY need four different next actions.
 */
export function describeApiFailure(err: unknown, fallback: string): ApiFailure {
  if (!(err instanceof ApiError)) {
    return {
      cause: fallback,
      nextAction: `${CHECK_LOGS}.`,
      retryable: true,
      requestId: undefined,
    };
  }

  // Present only when the server replied with an error envelope; `admin-api.ts`
  // reads it from `error.requestId`.
  const requestId = err.requestId;

  switch (err.code) {
    case 'NETWORK':
      return {
        cause:
          'Could not reach the admin server — the request never completed, so nothing is known about the data below.',
        nextAction:
          'Check that you are still connected and that the admin server is running, then retry.',
        retryable: true,
        requestId,
      };

    case 'BACKEND_MISCONFIGURATION':
      return {
        cause:
          "Admin backend misconfiguration — Session Manager rejected the admin server's credentials.",
        nextAction:
          "An operator must check that the admin server's ADMIN_API_KEY matches Session Manager's. Retrying will not help until it is fixed.",
        retryable: false,
        requestId,
      };

    case 'UPSTREAM_UNREACHABLE':
      return {
        cause: 'The admin server could not reach Session Manager.',
        nextAction:
          'Check that the session-manager service is running and reachable from the admin server, then retry.',
        retryable: true,
        requestId,
      };

    case 'RATE_LIMITED':
      return {
        // The server's own message carries the window ("retry after N").
        cause: err.message,
        nextAction:
          'Wait for that window to pass, then retry — nothing on this page retries on its own.',
        retryable: true,
        requestId,
      };

    case 'UNAUTHENTICATED':
      return {
        cause: 'Your admin session has expired.',
        nextAction:
          'Sign in again — the console is returning you to the login page.',
        retryable: false,
        requestId,
      };

    case 'FORBIDDEN':
      return {
        cause: err.message,
        nextAction:
          'Ask an administrator to grant your account the role this page needs. Retrying as you are will not help.',
        retryable: false,
        requestId,
      };

    case 'INVALID_RESPONSE':
      return {
        cause:
          'The admin server returned a response this console could not read.',
        nextAction:
          'Reload the page. If it persists just after a deployment, this browser tab may be running an outdated console build.',
        retryable: true,
        requestId,
      };

    default:
      break;
  }

  if (err.status === 404) {
    return {
      cause: err.message,
      nextAction:
        'It may have been deleted since this page was opened — reload to see the current state.',
      retryable: true,
      requestId,
    };
  }

  if (err.status >= 500) {
    return {
      cause: err.message,
      nextAction:
        requestId === undefined
          ? `${CHECK_LOGS}.`
          : `${CHECK_LOGS} for the request id below.`,
      retryable: true,
      requestId,
    };
  }

  return {
    cause: err.message,
    nextAction: `${CHECK_LOGS}.`,
    retryable: true,
    requestId,
  };
}
