import type { FastifyReply, FastifyRequest } from 'fastify';

import { HttpError } from '@scribear/base-fastify-server';

/**
 * PreHandler that validates API key authentication
 */
export async function authenticateApiKey(
  req: FastifyRequest,
  res: FastifyReply,
): Promise<void> {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    throw new HttpError.Unauthorized('Missing Authorization header');
  }

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'API-KEY') {
    throw new HttpError.Unauthorized(
      'Invalid Authorization header format. Expected: API-KEY <key>',
    );
  }

  const key = parts[1]!;
  const authService = req.diScope.resolve('authService');

  if (!authService.validateApiKey(key)) {
    throw new HttpError.Unauthorized('Invalid API key');
  }
}
