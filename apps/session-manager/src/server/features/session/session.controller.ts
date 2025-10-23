import type {
  BaseFastifyReply,
  BaseFastifyRequest,
} from '@scribear/base-fastify-server';
import { HttpError } from '@scribear/base-fastify-server';
import {
  CREATE_SESSION_SCHEMA,
  CREATE_TOKEN_SCHEMA,
} from '@scribear/session-manager-schema';

import type { AppDependencies } from '../../dependency_injection/register_dependencies.js';
import type { JwtService } from '../../services/jwt.service.js';
import type { SessionService } from './session.service.js';

class SessionController {
  private _sessionService: SessionService;
  private _jwtService: JwtService;

  constructor(
    sessionService: AppDependencies['sessionService'],
    jwtService: AppDependencies['jwtService'],
  ) {
    this._sessionService = sessionService;
    this._jwtService = jwtService;
  }

  async createSession(
    req: BaseFastifyRequest<typeof CREATE_SESSION_SCHEMA>,
    res: BaseFastifyReply<typeof CREATE_SESSION_SCHEMA>,
  ) {
    const { sessionLength, maxClients, enableJoinCode, audioSourceSecret } =
      req.body;

    const session = await this._sessionService.createSession({
      sessionLength,
      ...(maxClients !== undefined && { maxClients }),
      ...(enableJoinCode !== undefined && { enableJoinCode }),
      audioSourceSecret,
    });

    const response: {
      sessionId: string;
      joinCode?: string;
      expiresAt: string;
    } = {
      sessionId: session.sessionId,
      ...(session.joinCode && { joinCode: session.joinCode }),
      expiresAt: session.expiresAt.toISOString(),
    };

    res.code(200).send(response);
  }

  async createToken(
    req: BaseFastifyRequest<typeof CREATE_TOKEN_SCHEMA>,
    res: BaseFastifyReply<typeof CREATE_TOKEN_SCHEMA>,
  ) {
    const { sessionId, joinCode, audioSourceSecret, scope } = req.body;

    // Validate that either (sessionId + audioSourceSecret) or joinCode is provided
    if (!joinCode && (!sessionId || !audioSourceSecret)) {
      throw new HttpError.BadRequest([
        {
          message:
            'Must provide either joinCode OR (sessionId + audioSourceSecret)',
          key: 'authentication',
        },
      ]);
    }

    // Determine session ID based on input
    let resolvedSessionId: string;

    if (joinCode) {
      // Look up session by join code
      const session = this._sessionService.getSessionByJoinCode(joinCode);

      if (!session) {
        throw new HttpError.NotFound('Invalid join code');
      }

      resolvedSessionId = session.sessionId;
    } else {
      // Verify audio source secret
      const isValid = await this._sessionService.verifyAudioSourceSecret(
        sessionId!,
        audioSourceSecret!,
      );

      if (!isValid) {
        throw new HttpError.Unauthorized('Invalid session ID or audio source secret');
      }

      resolvedSessionId = sessionId!;
    }

    // Check if session is still valid
    if (!this._sessionService.isSessionValid(resolvedSessionId)) {
      throw new HttpError.NotFound('Session expired or not found');
    }

    // Issue JWT token
    const token = this._jwtService.issueToken(
      resolvedSessionId,
      scope,
      audioSourceSecret ? 'audio-source' : undefined,
    );

    res.code(200).send({
      token,
      expiresIn: '24h', // TODO: Make this configurable based on session
      sessionId: resolvedSessionId,
      scope,
    });
  }
}

export default SessionController;
