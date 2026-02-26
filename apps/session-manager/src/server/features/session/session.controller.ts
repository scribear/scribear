import type {
  BaseFastifyReply,
  BaseFastifyRequest,
} from '@scribear/base-fastify-server';
import { HttpError } from '@scribear/base-fastify-server';
import {
  CREATE_SESSION_SCHEMA,
  CREATE_TOKEN_SCHEMA,
} from '@scribear/session-manager-schema';

import type { AppDependencies } from '#src/server/dependency-injection/register-dependencies.js';

class SessionController {
  private _sessionService: AppDependencies['sessionService'];
  private _jwtService: AppDependencies['jwtService'];

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
      maxClients,
      enableJoinCode,
      audioSourceSecret,
    });

    res.code(200).send({
      sessionId: session.sessionId,
      ...(session.joinCode !== undefined && { joinCode: session.joinCode }),
      expiresAt: session.expiresAt.toISOString(),
    });
  }

  async createToken(
    req: BaseFastifyRequest<typeof CREATE_TOKEN_SCHEMA>,
    res: BaseFastifyReply<typeof CREATE_TOKEN_SCHEMA>,
  ) {
    const body = req.body;
    let resolvedSessionId: string;

    if ('joinCode' in body) {
      const { joinCode } = body;
      const session = this._sessionService.getSessionByJoinCode(joinCode);

      if (!session) {
        throw new HttpError.NotFound('Invalid join code');
      }

      resolvedSessionId = session.sessionId;
    } else {
      const { sessionId, audioSourceSecret } = body;

      const isValid = await this._sessionService.verifyAudioSourceSecret(
        sessionId,
        audioSourceSecret,
      );

      if (!isValid) {
        throw new HttpError.Unauthorized(
          'Invalid session ID or audio source secret',
        );
      }

      resolvedSessionId = sessionId;
    }

    if (!this._sessionService.isSessionValid(resolvedSessionId)) {
      throw new HttpError.NotFound('Session expired or not found');
    }

    const token = this._jwtService.issueToken(
      resolvedSessionId,
      body.scope,
      'joinCode' in body ? undefined : 'audio-source',
    );

    res.code(200).send({
      token,
      expiresIn: '24h', // TODO: Make this configurable based on instructor session configuration
      sessionId: resolvedSessionId,
      scope: body.scope,
    });
  }
}

export default SessionController;
