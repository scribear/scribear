import type { FastifyReply, FastifyRequest } from 'fastify';

import { HttpError } from '@scribear/base-fastify-server';

export async function apiKeyAuthHook(
  req: FastifyRequest,
  res: FastifyReply,
): Promise<void> {
  const authService = req.diScope.resolve('authService');
  if (!authService.isValidApiKey(req.headers.authorization)) {
    throw new HttpError.Unauthorized('Invalid or missing API key.');
  }
}
