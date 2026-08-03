import type { FastifyReply, FastifyRequest } from 'fastify';

import { HttpError } from '@scribear/base-fastify-server';
import type { BaseFastifyInstance } from '@scribear/base-fastify-server';
import {
  ADMIN_FETCH_JOIN_CODE_ROUTE,
  ADMIN_FETCH_JOIN_CODE_SCHEMA,
  EXCHANGE_DEVICE_TOKEN_ROUTE,
  EXCHANGE_DEVICE_TOKEN_SCHEMA,
  EXCHANGE_JOIN_CODE_ROUTE,
  EXCHANGE_JOIN_CODE_SCHEMA,
  FETCH_JOIN_CODE_ROUTE,
  FETCH_JOIN_CODE_SCHEMA,
  REFRESH_SESSION_TOKEN_ROUTE,
  REFRESH_SESSION_TOKEN_SCHEMA,
} from '@scribear/session-manager-schema';

import resolveHandler from '#src/server/dependency-injection/resolve-handler.js';
import { adminApiKeyHook } from '#src/server/hooks/admin-api-key.hook.js';
import { deviceTokenHook } from '#src/server/hooks/device-token.hook.js';

/**
 * Per-client-IP limits for the two unauthenticated credential-exchange routes,
 * plus the outcome-conditional cap on *failed* join-code exchanges. Supplied by
 * `AppConfig.sessionAuthRateLimitConfig`; every value is an env var rather than
 * a literal here, for the same two reasons admin-server moved its limits into
 * config: the right number depends on how many viewers a deployment puts behind
 * one egress IP, and a hard-coded limit forced the integration tests to spend a
 * real 60-second window to reach it.
 *
 * MEASURED INPUTS the shipped defaults are derived from.
 *
 * - Session tokens live 5 minutes (`SESSION_TOKEN_LIFETIME_MS` in
 *   `session-auth.service.ts`) and client-webapp re-refreshes at 50% of the
 *   *remaining* lifetime (`TOKEN_REFRESH_FRACTION`, ±10% jitter), so one viewer
 *   refreshes about every 150 s. N viewers behind one NAT therefore produce
 *   `N/150` refreshes per second in steady state.
 * - `refresh-session-token` runs one bcrypt cost-12 `compare` per call
 *   (`HASH_SALT_ROUNDS = 12` in `hash.service.ts`). Measured on a 20-core dev
 *   box: **154 ms per compare**, and **~25 compares/s** in aggregate with
 *   node's default 4-thread libuv pool. A *successful* `exchange-join-code`
 *   runs one bcrypt cost-12 `hash` (for the refresh token) at the same cost; a
 *   *failed* one runs none — it is a single indexed SELECT.
 * - Join codes are 8 characters drawn from a 36-character alphabet
 *   (`generate-random-code.ts`), so ~2.8×10¹² codes, each valid for 5 minutes
 *   (`JOIN_CODE_DURATION_MS`).
 *
 * WHY THE PREVIOUS 100 / 60 s WAS WRONG. It was calibrated as if it were a
 * credential-guessing defence. It is not one and cannot be: with even a few
 * thousand codes live at once a single guess lands with probability ~10⁻⁹, so
 * one IP guessing flat out at 600/min needs ~16 days for a 1% chance of a
 * single hit. Brute force is hopeless at 100/min and equally hopeless at
 * 100,000/min. What 100 / 60 s *did* do was fire on ordinary traffic: refresh
 * alone crosses it when `N/150 > 100/60`, i.e. at **N ≈ 250 viewers**, so a
 * 250-seat hall behind one campus NAT 429s continuously in steady state with
 * nobody doing anything unusual — and `exchange-join-code` trips earlier still,
 * since 100 joins in the first minute of class is roughly a 150-person lecture.
 *
 * WHAT THESE LIMITS ARE FOR INSTEAD: bounding the CPU a single source can
 * claim, and stopping a single runaway client. Note that none of them is a
 * service-wide capacity control — that ceiling is the bcrypt threadpool
 * (~25 calls/s in total, measured above) and it is global, not per-IP. Raising
 * a per-IP limit does not raise it.
 *
 * WHO ACTUALLY CALLS THESE ROUTES. Only client-webapp viewers. The kiosk
 * re-mints its token through `exchange-device-token` (`kiosk-service.ts`
 * `_refreshSessionToken`), and the monitoring canary authenticates the same
 * way; neither route is rate-limited, so neither shows up in the model above.
 * Viewer count is therefore the whole of the legitimate load. The only repo
 * tooling that spends from the failed-exchange budget is
 * `tools/session-corner-cases`, which submits two deliberately bad join codes
 * per run.
 *
 * WHAT "PER IP" ACTUALLY MEANS HERE. `create-server.ts` sets `trustProxy: 1`
 * and `infra/scribear-nginx/nginx.conf` appends the peer address to
 * `X-Forwarded-For`, so `req.ip` is the client address *as nginx saw it*, and
 * nginx applies no `limit_req` of its own — these limits are the only rate
 * control in the stack. But nginx's `set_real_ip_from` block is commented out
 * by default, deliberately (see the reasoning in nginx.conf), so a deployment
 * that puts a load balancer or CDN in front of that container without enabling
 * it gives every request the front proxy's address, and these stop being
 * per-client limits and become **deployment-wide** ones. That topology is the
 * sharpest argument for the raised defaults: at the old 100 / 60 s it capped a
 * whole deployment at ~250 concurrent viewers, not ~250 per NAT.
 */
export interface SessionAuthRateLimitConfig {
  /**
   * Volumetric per-IP cap on `exchange-join-code`, successful or not.
   *
   * Default 600 / 60 s. Sized so a 1,000-seat hall behind one NAT can all join
   * inside ~100 s without touching it. The upper bound comes from the other
   * side: 600 *successful* joins in a minute is 600 × 154 ms ≈ 92 CPU-seconds
   * of bcrypt, i.e. ~1.5 of the 4 libuv threads held by a single IP, which is
   * about the most one source should be able to take.
   */
  exchangeJoinCodeMax: number;
  exchangeJoinCodeWindowMs: number;

  /**
   * Per-IP cap on join-code exchanges that come back **404
   * `JOIN_CODE_NOT_FOUND`**. This is the actual anti-guessing control; the
   * volumetric cap above is a load backstop.
   *
   * Default 100 / 60 s — 6× tighter than the volumetric cap, and roughly twice
   * the worst legitimate burst modelled: a 250-seat hall joining at once with a
   * (pessimistic) 20% first-attempt typo rate produces ~50 404s in the same
   * minute. Its job is to bound and *surface* guessing (the block is logged
   * with the client IP), not to prevent it — the 2.8×10¹² code space already
   * does that, as the arithmetic above shows. Tighter would buy no security and
   * would start locking real rooms out.
   *
   * KEYED ON THE CLIENT IP, NEVER ON THE SUBMITTED JOIN CODE. Keying a limiter
   * on the credential being guessed hands the guesser a fresh bucket per guess,
   * which is strictly worse than having no limiter at all.
   *
   * COUNTED ONLY ON THE FAILURE. `@fastify/rate-limit` cannot do
   * outcome-conditional counting through `config.rateLimit` — that hook runs
   * before the handler — so this uses `fastify.createRateLimit()`, the manual
   * API added in v11: a `preHandler` peeks with `{ increment: false }` and an
   * `onSend` hook charges the bucket with `{ increment: true }` only when the
   * reply is a 404. A successful join never spends from this budget, so a full
   * lecture hall never approaches it.
   *
   * 410 `JOIN_CODE_EXPIRED` is deliberately **not** charged. A guesser
   * essentially never produces one — they would have had to guess a real code
   * out of 2.8×10¹² to be told it had expired — whereas a stale code left on a
   * projector makes an entire room produce one at the same instant. Charging
   * that would lock the room out of joining even after the presenter fixes the
   * display, which is the exact class of mistake this recalibration exists to
   * remove.
   */
  failedExchangeJoinCodeMax: number;
  failedExchangeJoinCodeWindowMs: number;

  /**
   * Volumetric per-IP cap on `refresh-session-token`.
   *
   * Default 1,000 / 60 s. This is the route that failed in steady state, and it
   * is also the weakest guessing surface in the service — a refresh token is
   * `{uuid}:{32 random bytes, base64url}`, i.e. 256 bits of secret checked
   * against the DB, so guessing is not a threat model at any rate. 1,000 / 60 s
   * covers 2,500 viewers behind one NAT in steady state (2500/150 ≈ 16.7/s),
   * comfortably more than any single lecture hall, and absorbs a whole-hall
   * reconnect burst for halls up to ~1,000 seats.
   *
   * NOT exempted altogether, for two reasons. First, this is the most expensive
   * unauthenticated call in the service: one bcrypt cost-12 compare, 154 ms of
   * libuv threadpool, measured. Second, this codebase has already seen a single
   * client hammer this route in an unbounded ~1 s loop — see
   * `REFRESH_MAX_CONSECUTIVE_FAILURES` in client-webapp's
   * `client-session-service.ts`, which exists because of it. 1,000 / 60 s is
   * ~17× that runaway rate, so the limit still catches the runaway while never
   * firing on a lecture hall.
   */
  refreshSessionTokenMax: number;
  refreshSessionTokenWindowMs: number;
}

/**
 * The only reply status charged to the failed-join-code budget. See
 * {@link SessionAuthRateLimitConfig.failedExchangeJoinCodeMax} for why 410 is
 * excluded and 200 obviously is.
 */
const GUESSED_JOIN_CODE_STATUS = 404;

export function sessionAuthRouter(
  fastify: BaseFastifyInstance,
  opts: SessionAuthRateLimitConfig,
) {
  fastify.route({
    ...FETCH_JOIN_CODE_ROUTE,
    schema: FETCH_JOIN_CODE_SCHEMA,
    preHandler: deviceTokenHook,
    handler: resolveHandler('sessionAuthController', 'fetchJoinCode'),
  });

  fastify.route({
    ...ADMIN_FETCH_JOIN_CODE_ROUTE,
    schema: ADMIN_FETCH_JOIN_CODE_SCHEMA,
    preHandler: adminApiKeyHook,
    handler: resolveHandler('sessionAuthController', 'adminFetchJoinCode'),
  });

  fastify.route({
    ...EXCHANGE_DEVICE_TOKEN_ROUTE,
    schema: EXCHANGE_DEVICE_TOKEN_SCHEMA,
    preHandler: deviceTokenHook,
    handler: resolveHandler('sessionAuthController', 'exchangeDeviceToken'),
  });

  // ONE limiter instance, invoked twice below with different `callOptions`.
  // `createRateLimit` builds a fresh child store on every call, so calling it
  // twice would give the peek and the charge separate buckets and the cap would
  // never fire. The default key generator is `req.ip` - see
  // `SessionAuthRateLimitConfig.failedExchangeJoinCodeMax` for why keying on the
  // submitted join code would be actively harmful.
  const failedJoinCodeLimit = fastify.createRateLimit({
    max: opts.failedExchangeJoinCodeMax,
    timeWindow: opts.failedExchangeJoinCodeWindowMs,
  });

  /**
   * `preHandler`: reject the request when this IP has already spent its
   * failed-exchange budget. Reads the counter without incrementing it, so the
   * only thing that ever charges the budget is an actual 404.
   */
  async function rejectSuspectedJoinCodeGuessing(
    req: FastifyRequest,
    reply: FastifyReply,
  ) {
    const state = await failedJoinCodeLimit(req, { increment: false });
    // `isAllowed: true` is the allow-list short circuit; there is no allow list
    // configured, so in practice the other branch is always taken.
    if (state.isAllowed || state.remaining > 0) return;

    // Set for parity with the volumetric limiter's 429, which sets it by
    // default. No client in this repo can read it yet - `createEndpointClient`
    // discards response headers - so nothing may promise a countdown.
    reply.header('retry-after', String(state.ttlInSeconds));

    // The operational half of this control: guessing is far too slow to
    // succeed, but it should not be invisible while it happens.
    req.log.warn(
      {
        clientIp: req.ip,
        max: state.max,
        timeWindowMs: state.timeWindow,
      },
      'Blocking join-code exchange: failed-attempt budget exhausted for this client IP',
    );

    throw HttpError.rateLimited('Too many requests. Please retry shortly.');
  }

  /**
   * `onSend`: charge the failed-exchange budget, and only then.
   *
   * `onSend` rather than `onResponse` on purpose. `onResponse` fires off the
   * socket's `finish` event, so it is not ordered against the *next* request:
   * a burst of concurrent guesses could all pass the `preHandler` peek before
   * any of them had been charged, which is the one traffic shape this cap is
   * supposed to stop. `onSend` is part of the awaited request lifecycle, so the
   * charge has landed before the guesser is told anything. The store is
   * in-memory and synchronous, so this adds no measurable latency.
   */
  async function chargeFailedJoinCodeExchange(
    req: FastifyRequest,
    reply: FastifyReply,
    payload: unknown,
  ) {
    if (reply.statusCode !== GUESSED_JOIN_CODE_STATUS) return payload;
    try {
      await failedJoinCodeLimit(req, { increment: true });
    } catch (err) {
      // The reply is already built and the user sees the same 404 either way,
      // so there is nothing to tell the client. But a store failure silently
      // weakens the cap, so it must not be swallowed without a trace.
      req.log.warn(
        { err },
        'Could not charge the failed-join-code rate limit; the cap is degraded',
      );
    }
    return payload;
  }

  // The next two routes are intentionally unauthenticated: the join code and
  // the refresh token themselves serve as the credential. They are the
  // credential-guessing surface, so they are rate-limited per client IP - see
  // `SessionAuthRateLimitConfig` above for what each limit is actually for and
  // how its default was derived.
  //
  // These are the *only* rate-limited routes in this service - the plugin is
  // registered with `global: false` (see create-server.ts) - which is why 429
  // is declared on exactly these two response schemas and not in
  // STANDARD_ERROR_REPLIES. If you add `config.rateLimit` to another route,
  // add `429: RATE_LIMITED_REPLY_SCHEMA` to its schema in the same commit, or
  // its callers will see the limit as an unexplained `UnexpectedResponseError`
  // again.
  fastify.route({
    ...EXCHANGE_JOIN_CODE_ROUTE,
    schema: EXCHANGE_JOIN_CODE_SCHEMA,
    config: {
      rateLimit: {
        max: opts.exchangeJoinCodeMax,
        timeWindow: opts.exchangeJoinCodeWindowMs,
      },
    },
    preHandler: rejectSuspectedJoinCodeGuessing,
    onSend: chargeFailedJoinCodeExchange,
    handler: resolveHandler('sessionAuthController', 'exchangeJoinCode'),
  });

  fastify.route({
    ...REFRESH_SESSION_TOKEN_ROUTE,
    schema: REFRESH_SESSION_TOKEN_SCHEMA,
    config: {
      rateLimit: {
        max: opts.refreshSessionTokenMax,
        timeWindow: opts.refreshSessionTokenWindowMs,
      },
    },
    handler: resolveHandler('sessionAuthController', 'refreshSessionToken'),
  });
}
