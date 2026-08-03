import { type MockInstance, vi } from 'vitest';

export interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface MockResponseSpec {
  status: number;
  /** JSON body; omit for 204. Must satisfy the route's declared response schema. */
  body?: unknown;
}

function normalizeHeaders(
  headers: HeadersInit | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  if (headers instanceof Headers) {
    headers.forEach((v, k) => (out[k.toLowerCase()] = v));
  } else if (Array.isArray(headers)) {
    for (const [k, v] of headers) out[k.toLowerCase()] = v;
  } else {
    for (const [k, v] of Object.entries(headers)) out[k.toLowerCase()] = v;
  }
  return out;
}

/**
 * Intercepts global `fetch` so the Session Manager client talks to a canned
 * upstream. Records every outgoing request (so tests can assert the injected
 * `Authorization: Bearer <adminKey>` header) and returns a configurable
 * response.
 */
export class SessionManagerMock {
  readonly requests: CapturedRequest[] = [];
  private _handler: (req: CapturedRequest) => MockResponseSpec;
  private _spy: MockInstance;

  constructor() {
    this._handler = () => ({
      status: 200,
      body: { items: [], nextCursor: null },
    });
    this._spy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(
        (input: string | URL | Request, init?: RequestInit) => {
          const url =
            typeof input === 'string'
              ? input
              : input instanceof URL
                ? input.href
                : input.url;
          // The client always sends a JSON string body (JSON.stringify).
          const rawBody =
            typeof init?.body === 'string' ? init.body : undefined;
          const captured: CapturedRequest = {
            url,
            method: init?.method ?? 'GET',
            headers: normalizeHeaders(init?.headers),
            body:
              rawBody != null ? (JSON.parse(rawBody) as unknown) : undefined,
          };
          this.requests.push(captured);

          const spec = this._handler(captured);
          if (spec.status === 204) {
            return Promise.resolve(new Response(null, { status: 204 }));
          }
          return Promise.resolve(
            new Response(JSON.stringify(spec.body ?? null), {
              status: spec.status,
              headers: { 'content-type': 'application/json' },
            }),
          );
        },
      );
  }

  /** Route every upstream call to the given response. */
  respondWith(spec: MockResponseSpec): void {
    this._handler = () => spec;
  }

  /** Custom per-request handler (e.g. branch on url/method). */
  setHandler(handler: (req: CapturedRequest) => MockResponseSpec): void {
    this._handler = handler;
  }

  get lastRequest(): CapturedRequest | undefined {
    return this.requests.at(-1);
  }

  restore(): void {
    this._spy.mockRestore();
  }
}
