import fastifyRateLimit from '@fastify/rate-limit';

import { BaseHttpError } from '@scribear/base-fastify-server';
import type { BaseFastifyInstance } from '@scribear/base-fastify-server';

export interface RateLimitConfig {
  globalMax: number;
  globalWindowMs: number;
  loginMax: number;
  loginWindowMs: number;
}

/**
 * Registers `@fastify/rate-limit` globally. The default keys by client IP;
 * because the BFF sits behind nginx we enable `trustProxy` on the Fastify
 * instance so the key is the real client IP (leftmost `X-Forwarded-For`).
 *
 * The login route tightens this via per-route `config.rateLimit` (see the auth
 * router); probes opt out via `config.rateLimit: false` so container health
 * checks are never throttled.
 *
 * Because this is `global: true`, EVERY admin route can answer 429 — unlike
 * session-manager, where the limiter is `global: false` and only two routes
 * opt in. Anything that renders an admin API failure must therefore be able to
 * explain a rate limit; see `errorMessage`/`errorSeverity` in admin-webapp's
 * `lib/api-error.ts`.
 */
export async function registerRateLimit(
  fastify: BaseFastifyInstance,
  config: RateLimitConfig,
): Promise<void> {
  await fastify.register(fastifyRateLimit, {
    global: true,
    max: config.globalMax,
    timeWindow: config.globalWindowMs,
    // The plugin THROWS whatever this returns, so return a BaseHttpError; the
    // admin error handler then serializes it as a `RATE_LIMITED` envelope.
    //
    // Constructed directly rather than via `HttpError.rateLimited(...)` because
    // that helper takes no `details`, and `details.retryAfter` is the only way
    // the wait ever reaches the browser: the plugin also sets a `retry-after`
    // header, but `AdminApiClient` (like `createEndpointClient`) returns only
    // status + body and discards headers entirely. Carrying it in the body is
    // what lets the console say "wait 1 minute" instead of "wait a moment".
    errorResponseBuilder: (_req, context) =>
      new BaseHttpError(
        429,
        'RATE_LIMITED',
        `Too many requests. Please retry after ${context.after}.`,
        // Human-readable duration from `@fastify/rate-limit` ("1 minute",
        // "45 seconds"), not a number of seconds — it is display copy.
        { retryAfter: context.after },
      ),
  });
}
