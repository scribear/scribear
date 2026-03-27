import type { FastifyReply, FastifyRequest } from 'fastify';
import type { HookHandlerDoneFunction } from 'fastify/types/hooks.js';

import { HttpError } from '@scribear/base-fastify-server';
import { DEVICE_COOKIE_NAME } from '@scribear/session-manager-schema';

declare module 'fastify' {
  interface FastifyRequest {
    deviceId: string;
  }
}

export function deviceCookieAuthHook(
  req: FastifyRequest,
  _reply: FastifyReply,
  done: HookHandlerDoneFunction,
) {
  const authService = req.diScope.resolve('authService');
  const token = req.cookies[DEVICE_COOKIE_NAME];
  if (!token) {
    done(new HttpError.Unauthorized('Missing device token.'));
    return;
  }

  authService
    .verifyDeviceToken(token)
    .then((result) => {
      if (!result) {
        done(new HttpError.Unauthorized('Invalid device token.'));
        return;
      }
      req.deviceId = result.deviceId;
      done();
    })
    .catch(done);
}
