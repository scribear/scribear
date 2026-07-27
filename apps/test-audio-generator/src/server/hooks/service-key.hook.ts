import type { FastifyReply, FastifyRequest } from 'fastify';
import type { HookHandlerDoneFunction } from 'fastify/types/hooks.js';

import { HttpError } from '@scribear/base-fastify-server';

/**
 * `onRequest` hook guarding every control route.
 *
 * Attached on the route object rather than as a plugin-scoped hook, matching
 * node-server's `serviceApiKeyHook`, so that adding a route is an explicit
 * decision about whether it needs the key rather than something it inherits.
 * Every route under `features/devices` takes it; the probes deliberately do
 * not, because the container's own `HEALTHCHECK` has no key to present.
 *
 * `onRequest` rather than node-server's `preHandler`, which is the one
 * deliberate difference. Body parsing and schema validation both run *between*
 * those two hooks, so a `preHandler` guard answers an unauthenticated caller
 * with a 400 describing the body it should have sent — the route's shape is
 * then discoverable without the key, and every unauthenticated request costs a
 * parse. Nothing here needs the body, so the check belongs before it.
 */
export function serviceKeyHook(
  req: FastifyRequest,
  _reply: FastifyReply,
  done: HookHandlerDoneFunction,
) {
  const serviceAuthService = req.diScope.resolve('serviceAuthService');
  if (!serviceAuthService.isValid(req.headers.authorization)) {
    done(
      HttpError.unauthorized(
        'Invalid or missing service key. This service is called by admin-server, which injects TEST_AUDIO_SERVICE_KEY itself.',
      ),
    );
    return;
  }
  done();
}
