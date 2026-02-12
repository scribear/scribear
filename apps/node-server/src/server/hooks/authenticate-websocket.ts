import type { FastifyRequest } from 'fastify';

import { HttpError } from '@scribear/base-fastify-server';

import type { JwtPayload } from '../services/jwt.service.js';

// Extend FastifyRequest to include JWT payload
declare module 'fastify' {
    interface FastifyRequest {
        jwtPayload?: JwtPayload;
    }
}

/**
 * PreHandler for WebSocket routes that verifies JWT tokens.
 * Extracts token from the `token` query parameter (since WebSocket
 * connections cannot set custom headers from browser clients).
 *
 * Usage: Apply this as a preHandler to WebSocket routes
 *
 * Example:
 * ```typescript
 * fastify.route({
 *   url: '/ws/:sessionId',
 *   method: 'GET',
 *   preHandler: authenticateWebsocket,
 *   handler: ...
 * });
 * ```
 */
export async function authenticateWebsocket(req: FastifyRequest): Promise<void> {
    const query = req.query as Record<string, string | undefined>;
    const token = query['token'];

    if (!token) {
        throw new HttpError.Unauthorized(
            'Missing token query parameter. Connect with ?token=<jwt>',
        );
    }

    // Verify token using JWT service from DI container
    const jwtService = req.diScope.resolve('jwtService');
    const result = jwtService.verifyToken(token);

    if (!result.valid) {
        throw new HttpError.Unauthorized(
            `Invalid or expired token: ${result.error ?? 'Unknown error'}`,
        );
    }

    // Attach payload to request for use in handlers
    if (result.payload) {
        req.jwtPayload = result.payload;
    }
}
