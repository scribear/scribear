import type { FastifyReply, FastifyRequest } from 'fastify';

import { HttpError } from '@scribear/base-fastify-server';
import { DEVICE_COOKIE_NAME } from '@scribear/session-manager-schema';

declare module 'fastify' {
  interface FastifyRequest {
    deviceId: string;
  }
}

export async function deviceCookieAuthHook(
  req: FastifyRequest,
  _reply: FastifyReply,
) {
  const authService = req.diScope.resolve('authService');
  const token = req.cookies?.[DEVICE_COOKIE_NAME];
  if (!token) {
    throw new HttpError.Unauthorized('Missing device token.');
  }
  const result = await authService.verifyDeviceToken(token);
  if (!result) {
    throw new HttpError.Unauthorized('Invalid device token.');
  }
  req.deviceId = result.deviceId;
}
