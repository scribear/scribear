/**
 * Thrown when the underlying `fetch()` call rejects. The request never
 * reached any server (DNS failure, TCP reset, CORS denial, etc.).
 */
class NetworkError extends Error {
  override readonly cause: unknown;

  /**
   * @param cause Original error thrown by fetch.
   */
  constructor(cause: unknown) {
    super('A network error occurred.');
    this.name = 'NetworkError';
    this.cause = cause;
  }
}

/**
 * Thrown when the response is not part of the declared contrAct - the status
 * code is not in the route schema's `response` map, or the body failed to
 * match the schema declared for that status.
 *
 * This covers every non-contract outcome in a single class:
 *
 * - Infrastructure responses (429, 502, 503, 504, etc.) where middleware or a
 *   gateway served the response - the route never declared those statuses,
 *   so they surface here.
 * - Contract drift where the server returned a body that no longer matches
 *   what the client was compiled against.
 *
 * Callers branch on `status` to distinguish the cases they care about.
 */
class UnexpectedResponseError extends Error {
  readonly status: number;

  /**
   * @param status HTTP status of the response that did not match contract.
   * @param message Optional override for the default message. Used by
   *   subclasses that describe a more specific off-contract outcome.
   */
  constructor(status: number, message?: string) {
    super(message ?? `Unexpected response with status ${status.toString()}.`);
    this.name = 'UnexpectedResponseError';
    this.status = status;
  }
}

/**
 * Thrown when a response arrived on a status the route *does* declare, but the
 * body could not be read as JSON at all - so it never even reached the schema
 * check.
 *
 * In practice this means something other than the service produced the body:
 *
 * - A reverse proxy or load balancer served its own HTML error page under a
 *   status the route declares (an nginx 500 page is the canonical case).
 * - The response had no body at all (an empty-bodied 400, for example) on a
 *   status other than 204.
 * - The connection dropped mid-body, leaving truncated JSON.
 *
 * It extends {@link UnexpectedResponseError}, so existing `instanceof`
 * branches and any `status`-based handling keep working unchanged. Callers
 * that want to tell "there was no structured error body to read" apart from
 * "the body was JSON but did not match the declared schema" - which is a plain
 * `UnexpectedResponseError` - can check for this subclass and reach for a
 * message about the server being unreachable or misconfigured rather than one
 * about a version mismatch.
 */
class InvalidResponseBodyError extends UnexpectedResponseError {
  override readonly cause: unknown;

  /**
   * @param status HTTP status of the response whose body could not be parsed.
   * @param cause Original error thrown while reading or parsing the body -
   *   typically a `SyntaxError` from `Response.json()`, or a `TypeError` when
   *   the body stream failed.
   */
  constructor(status: number, cause: unknown) {
    super(
      status,
      `Response with status ${status.toString()} did not have a readable JSON body.`,
    );
    this.name = 'InvalidResponseBodyError';
    this.cause = cause;
  }
}

export { NetworkError, UnexpectedResponseError, InvalidResponseBodyError };
