import type { FastifyRequest, FastifyReply } from 'fastify';
import { HttpError } from '@scribear/base-fastify-server';

import type { JwtPayload } from '../services/jwt.service.js';
import type { AppDependencies } from '../dependency_injection/register_dependencies.js';

// Extend FastifyRequest to include JWT payload
declare module 'fastify' {
  interface FastifyRequest {
    jwtPayload?: JwtPayload;
  }
}

/**
 * PreHandler function that verifies JWT tokens
 * Extracts token from Authorization header (Bearer scheme)
 * Verifies token and attaches payload to request
 *
 * Usage: Apply this as a preHandler to routes that require authentication
 *
 * Example:
 * ```typescript
 * fastify.route({
 *   url: '/protected',
 *   method: 'GET',
 *   preHandler: authenticateJwt,
 *   handler: async (req, res) => {
 *     // req.jwtPayload will be available here
 *   }
 * });
 * ```
 */
export async function authenticateJwt(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  // Extract Authorization header
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    throw new HttpError.Unauthorized('Missing Authorization header');
  }

  // Check Bearer scheme
  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    throw new HttpError.Unauthorized(
      'Invalid Authorization header format. Expected: Bearer <token>',
    );
  }

  const token = parts[1];

  // Verify token using JWT service from DI container
  const jwtService = (req as any).diScope.resolve('jwtService');
  const result = jwtService.verifyToken(token);

  if (!result.valid) {
    throw new HttpError.Unauthorized(
      `Invalid or expired token: ${result.error}`,
    );
  }

  // Attach payload to request for use in handlers
  req.jwtPayload = result.payload;
}

/**
 * Optional JWT authentication preHandler
 * Similar to authenticateJwt but doesn't fail if token is missing
 * Only validates if token is present
 *
 * Useful for routes that have different behavior for authenticated vs unauthenticated users
 */
export async function optionalAuthenticateJwt(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const authHeader = req.headers.authorization;

  // If no auth header, just continue without setting jwtPayload
  if (!authHeader) {
    return;
  }

  const parts = authHeader.split(' ');
  if (parts.length === 2 && parts[0] === 'Bearer') {
    const token = parts[1];
    const jwtService = (req as any).diScope.resolve('jwtService');
    const result = jwtService.verifyToken(token);

    if (result.valid) {
      req.jwtPayload = result.payload;
    }
  }
}
