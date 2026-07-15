import type { FastifyReply, FastifyRequest } from 'fastify';
import type { HookHandlerDoneFunction } from 'fastify/types/hooks.js';

import { HttpError } from '@scribear/base-fastify-server';

export function serviceApiKeyHook(
  req: FastifyRequest,
  _reply: FastifyReply,
  done: HookHandlerDoneFunction,
) {
  const serviceAuthService = req.diScope.resolve('serviceAuthService');
  if (!serviceAuthService.isValid(req.headers.authorization)) {
    done(HttpError.unauthorized('Invalid or missing service API key.'));
    return;
  }
  done();
}
