import type { FastifyReply, FastifyRequest } from 'fastify';
import type { HookHandlerDoneFunction } from 'fastify/types/hooks.js';

import { HttpError } from '@scribear/base-fastify-server';

export function nodeServerKeyAuthHook(
  req: FastifyRequest,
  _reply: FastifyReply,
  done: HookHandlerDoneFunction,
) {
  const authService = req.diScope.resolve('authService');
  if (!authService.isValidNodeServerKey(req.headers.authorization)) {
    done(new HttpError.Unauthorized('Invalid or missing node server key.'));
    return;
  }
  done();
}
