import fastifyRateLimit from '@fastify/rate-limit';

import { HttpError } from '@scribear/base-fastify-server';
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
    errorResponseBuilder: (_req, context) =>
      HttpError.rateLimited(
        `Too many requests. Please retry after ${context.after}.`,
      ),
  });
}
