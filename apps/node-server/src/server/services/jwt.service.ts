import jwt from 'jsonwebtoken';

import type { BaseDependencies } from '@scribear/base-fastify-server';

export type SessionScope = 'source' | 'sink' | 'both';

export interface JwtPayload {
    sessionId: string;
    scope: SessionScope;
    /**
     * Optional audio source identifier for source connections
     */
    sourceId?: string | undefined;
}

export interface JwtVerificationResult {
    valid: boolean;
    payload?: JwtPayload;
    error?: string;
}

export interface JwtServiceConfig {
    jwtSecret: string;
    jwtIssuer: string;
}

/**
 * JWT verification service for the node-server.
 * Verifies tokens issued by session-manager. Does NOT issue tokens.
 */
export class JwtService {
    private _log: BaseDependencies['logger'];
    private _secret: string;
    private _issuer: string;

    constructor(
        logger: BaseDependencies['logger'],
        jwtServiceConfig: JwtServiceConfig,
    ) {
        this._log = logger;
        this._secret = jwtServiceConfig.jwtSecret;
        this._issuer = jwtServiceConfig.jwtIssuer;
    }

    /**
     * Verify and decode a JWT token
     * @param token - The JWT token string to verify
     * @returns Verification result with payload or error
     */
    verifyToken(token: string): JwtVerificationResult {
        try {
            const decoded = jwt.verify(token, this._secret, {
                issuer: this._issuer,
                algorithms: ['HS256'],
            }) as JwtPayload;

            this._log.debug(
                { sessionId: decoded.sessionId, scope: decoded.scope },
                'JWT token verified successfully',
            );

            return {
                valid: true,
                payload: decoded,
            };
        } catch (error) {
            const errorMessage =
                error instanceof Error ? error.message : 'Unknown error';

            this._log.warn({ error: errorMessage }, 'JWT verification failed');

            return {
                valid: false,
                error: errorMessage,
            };
        }
    }
}
