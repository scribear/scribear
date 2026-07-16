/**
 * Error thrown by the admin API client for any non-ok response. Carries the
 * BFF envelope's `code`/`message`/`requestId` plus the HTTP status so callers
 * can branch (e.g. 409 conflict guidance, 502 backend misconfiguration).
 */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly requestId: string | undefined;

  constructor(
    code: string,
    message: string,
    status: number,
    requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.requestId = requestId;
  }
}

/** True when the error is an ApiError with the given code. */
export function isApiErrorCode(err: unknown, code: string): boolean {
  return err instanceof ApiError && err.code === code;
}
