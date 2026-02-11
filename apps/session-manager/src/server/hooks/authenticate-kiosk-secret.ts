import type { FastifyReply, FastifyRequest } from 'fastify';

import { HttpError } from '@scribear/base-fastify-server';

/**
 * PreHandler that validates kiosk token authentication
 *
 * Expects: Authorization: KIOSK-TOKEN <base64-encoded-token>
 * where token = base64(kioskId:secret)
 */
export async function authenticateKioskToken(
  req: FastifyRequest,
  res: FastifyReply,
): Promise<void> {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    throw new HttpError.Unauthorized('Missing Authorization header');
  }

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'KIOSK-TOKEN') {
    throw new HttpError.Unauthorized(
      'Invalid Authorization header format. Expected: KIOSK-TOKEN <token>',
    );
  }

  const token = parts[1]!;
  const authService = req.diScope.resolve('authService');

  if (!(await authService.validateKioskToken(token))) {
    throw new HttpError.Unauthorized('Invalid kiosk token');
  }
}
