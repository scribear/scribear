/**
 * Thrown when the WebSocket fails to establish a connection.
 */
class ConnectionError extends Error {
  override readonly cause: unknown;

  /**
   * @param cause - The original error from the WebSocket error event.
   */
  constructor(cause: unknown) {
    super('Failed to establish WebSocket connection.');
    this.name = 'ConnectionError';
    this.cause = cause;
  }
}

/**
 * Emitted on the error event when a received server message does not match
 * the TypeBox schema defined in the route schema.
 */
class SchemaValidationError extends Error {
  /**
   * @param message - Description of the validation failure.
   */
  constructor(message: string) {
    super(message);
    this.name = 'SchemaValidationError';
  }
}

export { ConnectionError, SchemaValidationError };
