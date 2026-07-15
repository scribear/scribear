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
   */
  constructor(status: number) {
    super(`Unexpected response with status ${status.toString()}.`);
    this.name = 'UnexpectedResponseError';
    this.status = status;
  }
}

export { NetworkError, UnexpectedResponseError };
