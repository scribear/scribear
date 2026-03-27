/**
 * Thrown when the underlying fetch() call fails due to a network-level issue.
 */
class NetworkError extends Error {
  override readonly cause: unknown;

  /**
   * @param cause - The original error thrown by fetch().
   */
  constructor(cause: unknown) {
    super('A network error occurred.');
    this.name = 'NetworkError';
    this.cause = cause;
  }
}

/**
 * Thrown when a response body does not match the TypeBox schema defined for its status code,
 * or when the response status code has no schema defined.
 */
class SchemaValidationError extends Error {
  readonly status: number;

  /**
   * @param status - The HTTP status code of the response that failed validation.
   */
  constructor(status: number) {
    super(
      `Response for status ${status.toString()} did not match expected schema.`,
    );
    this.name = 'SchemaValidationError';
    this.status = status;
  }
}

export { NetworkError, SchemaValidationError };
