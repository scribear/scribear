/**
 * Consistent response envelope for every `/api/admin` route so the SPA can
 * render successes and failures uniformly.
 */
export interface OkEnvelope<T> {
  ok: true;
  data: T;
}

export interface ErrorEnvelope {
  ok: false;
  error: {
    code: string;
    message: string;
    requestId: string;
    details?: Record<string, unknown>;
  };
}

export function okEnvelope<T>(data: T): OkEnvelope<T> {
  return { ok: true, data };
}

export function errorEnvelope(
  code: string,
  message: string,
  requestId: string,
  details?: Record<string, unknown>,
): ErrorEnvelope {
  return {
    ok: false,
    error: details
      ? { code, message, requestId, details }
      : { code, message, requestId },
  };
}
