import type { FastifyReply, FastifyRequest } from 'fastify';
import type { HookHandlerDoneFunction } from 'fastify/types/hooks.js';

import { HttpError } from '@scribear/base-fastify-server';

export function adminApiKeyHook(
  req: FastifyRequest,
  _reply: FastifyReply,
  done: HookHandlerDoneFunction,
) {
  const adminAuthService = req.diScope.resolve('adminAuthService');
  if (!adminAuthService.isValid(req.headers.authorization)) {
    done(HttpError.unauthorized('Invalid or missing admin API key.'));
    return;
  }
  done();
}
