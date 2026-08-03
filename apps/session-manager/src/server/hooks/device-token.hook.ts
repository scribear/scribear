import type { FastifyReply, FastifyRequest } from 'fastify';
import type { HookHandlerDoneFunction } from 'fastify/types/hooks.js';

import { HttpError } from '@scribear/base-fastify-server';
import { DEVICE_TOKEN_COOKIE_NAME } from '@scribear/session-manager-schema';

declare module 'fastify' {
  interface FastifyRequest {
    deviceUid?: string;
  }
}

const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

export function deviceTokenHook(
  req: FastifyRequest,
  reply: FastifyReply,
  done: HookHandlerDoneFunction,
) {
  const deviceAuthService = req.diScope.resolve('deviceAuthService');
  const devicePresenceService = req.diScope.resolve('devicePresenceService');
  const baseConfig = req.diScope.resolve('baseConfig');
  const token = req.cookies[DEVICE_TOKEN_COOKIE_NAME];
  if (!token) {
    done(HttpError.unauthorized('Missing device token.'));
    return;
  }

  deviceAuthService
    .verify(token)
    .then((result) => {
      if (!result) {
        done(HttpError.unauthorized('Invalid or revoked device token.'));
        return;
      }
      req.deviceUid = result.deviceUid;

      // Stamped here rather than in a handler so presence covers every
      // device-authenticated route: a device talking to us at all is alive,
      // whatever it happens to be asking for. The write is coalesced and
      // fire-and-forget, so this does not add a round trip to the request.
      devicePresenceService.touch(result.deviceUid);

      reply.setCookie(DEVICE_TOKEN_COOKIE_NAME, token, {
        httpOnly: true,
        path: '/',
        secure: !baseConfig.isDevelopment,
        sameSite: 'strict',
        maxAge: COOKIE_MAX_AGE_SECONDS,
      });

      done();
    })
    .catch(done);
}
