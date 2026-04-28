import {
  type BaseFastifyReply,
  type BaseFastifyRequest,
  BaseHttpError,
  HttpError,
} from '@scribear/base-fastify-server';
import {
  EXCHANGE_DEVICE_TOKEN_SCHEMA,
  EXCHANGE_JOIN_CODE_SCHEMA,
  FETCH_JOIN_CODE_SCHEMA,
  REFRESH_SESSION_TOKEN_SCHEMA,
} from '@scribear/session-manager-schema';

import type { AppDependencies } from '#src/server/dependency-injection/app-dependencies.js';

export class SessionAuthController {
  private _sessionAuthService: AppDependencies['sessionAuthService'];

  constructor(sessionAuthService: AppDependencies['sessionAuthService']) {
    this._sessionAuthService = sessionAuthService;
  }

  async fetchJoinCode(
    req: BaseFastifyRequest<typeof FETCH_JOIN_CODE_SCHEMA>,
    res: BaseFastifyReply<typeof FETCH_JOIN_CODE_SCHEMA>,
  ) {
    if (!req.deviceUid) throw HttpError.internal();

    const result = await this._sessionAuthService.fetchJoinCodes(
      req.deviceUid,
      req.body.sessionUid,
      new Date(),
    );

    if (result === 'SESSION_NOT_FOUND') {
      throw HttpError.notFound('SESSION_NOT_FOUND', 'Session not found.');
    }
    if (result === 'DEVICE_NOT_IN_SESSION_ROOM') {
      throw HttpError.forbidden(
        'DEVICE_NOT_IN_SESSION_ROOM',
        'Device is not a member of the session room.',
      );
    }
    if (result === 'JOIN_CODE_SCOPES_EMPTY') {
      throw HttpError.conflict(
        'JOIN_CODE_SCOPES_EMPTY',
        'Session has no join code scopes configured.',
      );
    }

    res.code(200).send({
      current: {
        joinCode: result.current.joinCode,
        validStart: result.current.validStart.toISOString(),
        validEnd: result.current.validEnd.toISOString(),
      },
      next:
        result.next === null
          ? null
          : {
              joinCode: result.next.joinCode,
              validStart: result.next.validStart.toISOString(),
              validEnd: result.next.validEnd.toISOString(),
            },
    });
  }

  async exchangeDeviceToken(
    req: BaseFastifyRequest<typeof EXCHANGE_DEVICE_TOKEN_SCHEMA>,
    res: BaseFastifyReply<typeof EXCHANGE_DEVICE_TOKEN_SCHEMA>,
  ) {
    if (!req.deviceUid) throw HttpError.internal();

    const result = await this._sessionAuthService.exchangeDeviceToken(
      req.deviceUid,
      req.body.sessionUid,
      new Date(),
    );

    if (result === 'SESSION_NOT_FOUND') {
      throw HttpError.notFound('SESSION_NOT_FOUND', 'Session not found.');
    }
    if (result === 'DEVICE_NOT_IN_SESSION_ROOM') {
      throw HttpError.forbidden(
        'DEVICE_NOT_IN_SESSION_ROOM',
        'Device is not a member of the session room.',
      );
    }
    if (result === 'SESSION_NOT_CURRENTLY_ACTIVE') {
      throw HttpError.conflict(
        'SESSION_NOT_CURRENTLY_ACTIVE',
        'Session is not currently active.',
      );
    }

    res.code(200).send({
      sessionToken: result.sessionToken,
      sessionTokenExpiresAt: result.sessionTokenExpiresAt.toISOString(),
      scopes: result.scopes,
    });
  }

  async exchangeJoinCode(
    req: BaseFastifyRequest<typeof EXCHANGE_JOIN_CODE_SCHEMA>,
    res: BaseFastifyReply<typeof EXCHANGE_JOIN_CODE_SCHEMA>,
  ) {
    const result = await this._sessionAuthService.exchangeJoinCode(
      req.body.joinCode,
      new Date(),
    );

    if (result === 'JOIN_CODE_NOT_FOUND') {
      throw HttpError.notFound('JOIN_CODE_NOT_FOUND', 'Join code not found.');
    }
    if (result === 'JOIN_CODE_EXPIRED') {
      throw HttpError.gone('JOIN_CODE_EXPIRED', 'Join code has expired.');
    }
    if (result === 'SESSION_NOT_CURRENTLY_ACTIVE') {
      throw HttpError.conflict(
        'SESSION_NOT_CURRENTLY_ACTIVE',
        'Session is not currently active.',
      );
    }

    res.code(200).send({
      sessionUid: result.sessionUid,
      clientId: result.clientId,
      sessionToken: result.sessionToken,
      sessionTokenExpiresAt: result.sessionTokenExpiresAt.toISOString(),
      sessionRefreshToken: result.sessionRefreshToken,
      scopes: result.scopes,
    });
  }

  async refreshSessionToken(
    req: BaseFastifyRequest<typeof REFRESH_SESSION_TOKEN_SCHEMA>,
    res: BaseFastifyReply<typeof REFRESH_SESSION_TOKEN_SCHEMA>,
  ) {
    const result = await this._sessionAuthService.refreshSessionToken(
      req.body.sessionRefreshToken,
      new Date(),
    );

    if (result === 'INVALID_REFRESH_TOKEN') {
      // The schema requires a 401 with `code: 'INVALID_REFRESH_TOKEN'`, which
      // `HttpError.unauthorized` cannot produce (it always sets `UNAUTHORIZED`).
      throw new BaseHttpError(
        401,
        'INVALID_REFRESH_TOKEN',
        'Invalid or revoked refresh token.',
      );
    }
    if (result === 'SESSION_ENDED') {
      throw HttpError.conflict('SESSION_ENDED', 'Session has ended.');
    }

    res.code(200).send({
      sessionToken: result.sessionToken,
      sessionTokenExpiresAt: result.sessionTokenExpiresAt.toISOString(),
    });
  }
}
