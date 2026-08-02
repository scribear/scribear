import { Type } from 'typebox';

/**
 * Generic error body shape. The service declares this for statuses whose
 * `code` value depends on per-route context (`401`, `403`, `404`, `409`,
 * `422`); the exact code values are documented in each route's description.
 *
 * For the two statuses where the code is always the same, use the
 * specialized schemas below which narrow `code` with a literal. Statuses
 * emitted by layers outside the service entirely (reverse proxy, load
 * balancer) do not have a service-owned schema at all; the client-side
 * `UnexpectedResponseError` in `@scribear/base-api-client` surfaces them
 * based on status alone.
 */
export const ERROR_REPLY_SCHEMA = Type.Object(
  {
    code: Type.String({
      description:
        'Stable uppercase snake-case error code identifier. The specific values a given route can emit are documented in the route description.',
      examples: ['VALIDATION_ERROR'],
    }),
    message: Type.String({
      description: 'Human-readable summary suitable for logs.',
    }),
    details: Type.Optional(
      Type.Record(Type.String(), Type.Unknown(), {
        description:
          'Optional context-specific fields. Shape varies per endpoint and code.',
      }),
    ),
  },
  {
    $id: 'ErrorReply',
    description:
      'Canonical error body. Used directly by routes for statuses whose code varies (401, 403, 404, 409, 422).',
  },
);

/**
 * 400 Bad Request. Always emitted by the schema validator when the request
 * body, querystring, params, or headers fail TypeBox validation. `code` is
 * always `VALIDATION_ERROR`; `details.validationErrors` carries one entry per
 * failed field.
 */
export const VALIDATION_ERROR_REPLY_SCHEMA = Type.Object(
  {
    code: Type.Literal('VALIDATION_ERROR'),
    message: Type.String({
      description: 'Human-readable summary of the validation failure.',
    }),
    details: Type.Optional(
      Type.Object(
        {
          validationErrors: Type.Array(
            Type.Object({
              message: Type.String({
                description:
                  'Field-level validator message, e.g. "Expected string, got number".',
              }),
              path: Type.String({
                description:
                  'JSON pointer into the request describing the failed location, prefixed with the input site (/body, /query, /params, /headers).',
                examples: ['/body/timezone'],
              }),
            }),
          ),
        },
        {
          description:
            'Envelope carrying one per-field validator message for each failure.',
        },
      ),
    ),
  },
  {
    $id: 'ValidationErrorReply',
    description:
      '400 Bad Request emitted by the request validator. `code` is always `VALIDATION_ERROR`.',
  },
);

/**
 * 405 Method Not Allowed. Emitted by the framework when a route exists but
 * is not registered for the requested HTTP method. `code` is always
 * `METHOD_NOT_ALLOWED`.
 */
export const METHOD_NOT_ALLOWED_REPLY_SCHEMA = Type.Object(
  {
    code: Type.Literal('METHOD_NOT_ALLOWED'),
    message: Type.String({ description: 'Human-readable summary.' }),
  },
  {
    $id: 'MethodNotAllowedReply',
    description:
      '405 Method Not Allowed. Emitted by the framework when the route exists for a different HTTP method. `code` is always `METHOD_NOT_ALLOWED`.',
  },
);

/**
 * 406 Not Acceptable. Emitted by the framework when content negotiation
 * fails (the client's `Accept` header cannot be satisfied). `code` is always
 * `NOT_ACCEPTABLE`.
 */
export const NOT_ACCEPTABLE_REPLY_SCHEMA = Type.Object(
  {
    code: Type.Literal('NOT_ACCEPTABLE'),
    message: Type.String({ description: 'Human-readable summary.' }),
  },
  {
    $id: 'NotAcceptableReply',
    description:
      '406 Not Acceptable. Emitted by the framework when content negotiation fails. `code` is always `NOT_ACCEPTABLE`.',
  },
);

/**
 * 415 Unsupported Media Type. Emitted by the framework when the request
 * `Content-Type` is not accepted. `code` is always `UNSUPPORTED_MEDIA_TYPE`.
 */
export const UNSUPPORTED_MEDIA_TYPE_REPLY_SCHEMA = Type.Object(
  {
    code: Type.Literal('UNSUPPORTED_MEDIA_TYPE'),
    message: Type.String({ description: 'Human-readable summary.' }),
  },
  {
    $id: 'UnsupportedMediaTypeReply',
    description:
      '415 Unsupported Media Type. Emitted by the framework when the request Content-Type is not accepted. `code` is always `UNSUPPORTED_MEDIA_TYPE`.',
  },
);

/**
 * 429 Too Many Requests. Emitted by `@fastify/rate-limit` on a route that
 * opted into a rate limit, via the `errorResponseBuilder` each service
 * installs - which throws `HttpError.rateLimited(...)`, so the body lands in
 * the canonical `ErrorReply` shape like any other thrown error. `code` is
 * always `RATE_LIMITED`.
 *
 * Deliberately **not** in {@link STANDARD_ERROR_REPLIES}: rate limiting is
 * opt-in per route, and declaring a status a route can never emit is worse
 * than useless - it appears in the generated OpenAPI, and it adds an arm to
 * every caller's `EndpointResponse` union that nothing can produce. Spread it
 * into the `response` map of the routes that actually carry a
 * `config.rateLimit`, and nowhere else.
 *
 * Note for callers: the plugin also sets a `retry-after` header (in seconds),
 * but `createEndpointClient` returns only status + body, so that value is not
 * reachable from a typed endpoint client today. Treat 429 as "wait, this
 * clears on its own" rather than promising the user a specific countdown.
 */
export const RATE_LIMITED_REPLY_SCHEMA = Type.Object(
  {
    code: Type.Literal('RATE_LIMITED'),
    message: Type.String({ description: 'Human-readable summary.' }),
  },
  {
    $id: 'RateLimitedReply',
    description:
      '429 Too Many Requests. Emitted by the rate limiter on routes that opt into one. `code` is always `RATE_LIMITED`. Transient: the limit window expires on its own.',
  },
);

/**
 * 500 Internal Server Error. Emitted when the server encountered an
 * unexpected exception. `code` is always `INTERNAL_ERROR`. Callers should
 * treat this as "retry with backoff; the issue is server-side."
 */
export const INTERNAL_ERROR_REPLY_SCHEMA = Type.Object(
  {
    code: Type.Literal('INTERNAL_ERROR'),
    message: Type.String({
      description:
        'Generic user-facing message. Does not carry exception details.',
    }),
  },
  {
    $id: 'InternalErrorReply',
    description:
      '500 Internal Server Error. `code` is always `INTERNAL_ERROR`. No stable meaning beyond "the server failed."',
  },
);

/**
 * Statuses whose `code` is always fixed regardless of route. Spread into a
 * route's `response` map; routes add their own 401 / 403 / 404 / 409 / 410 /
 * 422 entries alongside using `ERROR_REPLY_SCHEMA`.
 *
 * 401 is intentionally omitted: the expected `code` on a 401 depends on the
 * route's auth method(s) (e.g. `INVALID_ADMIN_KEY` vs `INVALID_DEVICE_TOKEN`).
 *
 * Infrastructure statuses (408, 413, 502, 503, 504) are not declared here
 * because their response bodies are emitted by middleware (body-size
 * middleware, reverse proxies) rather than the service. The client-side
 * `UnexpectedResponseError` in `@scribear/base-api-client` surfaces them
 * based on status alone.
 *
 * 429 is the exception that proves the rule and is still not here: the body
 * *is* service-owned (see {@link RATE_LIMITED_REPLY_SCHEMA}), but only routes
 * carrying a `config.rateLimit` can ever emit it, so it is declared per route
 * rather than globally.
 *
 * Not a counter-example: **admin-server registers its limiter with
 * `global: true`**, so every one of its routes really can answer 429. Adding
 * 429 here would still be wrong, and would not help it. This constant is
 * spread by 92 route schemas, all of them in session-manager and node-server —
 * services whose limiters are `global: false` — so widening it adds an
 * unreachable arm to every one of their `EndpointResponse` unions. admin-server
 * gains nothing either way: it is a BFF that declares no `response` map for any
 * error status and serializes failures as its own
 * `{ ok: false, error: { code, message, requestId, details } }` envelope, which
 * `ErrorReply` does not describe. Its 429 contract is pinned by
 * `apps/admin-server/tests/integration/rate-limit.routes.test.ts` instead.
 */
export const STANDARD_ERROR_REPLIES = {
  400: VALIDATION_ERROR_REPLY_SCHEMA,
  405: METHOD_NOT_ALLOWED_REPLY_SCHEMA,
  406: NOT_ACCEPTABLE_REPLY_SCHEMA,
  415: UNSUPPORTED_MEDIA_TYPE_REPLY_SCHEMA,
  500: INTERNAL_ERROR_REPLY_SCHEMA,
} as const;
