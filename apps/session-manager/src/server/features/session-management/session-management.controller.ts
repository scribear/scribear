import type {
  BaseFastifyReply,
  BaseFastifyRequest,
} from '@scribear/base-fastify-server';
import { HttpError } from '@scribear/base-fastify-server';
import {
  CREATE_SESSION_SCHEMA,
  DEVICE_SESSION_EVENTS_SCHEMA,
  type END_SESSION_SCHEMA,
  type GET_SESSION_CONFIG_SCHEMA,
  type REFRESH_SESSION_TOKEN_SCHEMA,
  type SESSION_JOIN_CODE_AUTH_SCHEMA,
  type SOURCE_DEVICE_SESSION_AUTH_SCHEMA,
} from '@scribear/session-manager-schema';

import type { AppDependencies } from '#src/server/dependency-injection/register-dependencies.js';

export class SessionManagementController {
  private _sessionManagementService: AppDependencies['sessionManagementService'];

  constructor(
    sessionManagementService: AppDependencies['sessionManagementService'],
  ) {
    this._sessionManagementService = sessionManagementService;
  }

  async createSession(
    req: BaseFastifyRequest<typeof CREATE_SESSION_SCHEMA>,
    res: BaseFastifyReply<typeof CREATE_SESSION_SCHEMA>,
  ) {
    const {
      sourceDeviceId,
      transcriptionProviderKey,
      transcriptionProviderConfig,
      endTimeUnixMs,
      enableJoinCode,
      joinCodeLength,
      enableJoinCodeRotation,
    } = req.body;

    const result = await this._sessionManagementService.createOnDemandSession(
      sourceDeviceId,
      transcriptionProviderKey,
      transcriptionProviderConfig,
      endTimeUnixMs,
      enableJoinCode ?? false,
      joinCodeLength,
      enableJoinCodeRotation,
    );

    if (!result) {
      throw new HttpError.UnprocessableEntity('Invalid session parameters.');
    }

    res.code(200).send({ sessionId: result.sessionId });
  }

  async sessionAuth(
    req: BaseFastifyRequest<typeof SESSION_JOIN_CODE_AUTH_SCHEMA>,
    res: BaseFastifyReply<typeof SESSION_JOIN_CODE_AUTH_SCHEMA>,
  ) {
    const { joinCode } = req.body;

    const result =
      await this._sessionManagementService.authenticateWithJoinCode(joinCode);

    if (!result) {
      throw new HttpError.UnprocessableEntity('Invalid or expired join code.');
    }

    res.code(200).send({
      sessionToken: result.sessionToken,
      sessionRefreshToken: result.sessionRefreshToken,
    });
  }

  async sourceDeviceSessionAuth(
    req: BaseFastifyRequest<typeof SOURCE_DEVICE_SESSION_AUTH_SCHEMA>,
    res: BaseFastifyReply<typeof SOURCE_DEVICE_SESSION_AUTH_SCHEMA>,
  ) {
    const { sessionId } = req.body;

    const result =
      await this._sessionManagementService.authenticateSourceDevice(
        req.deviceId,
        sessionId,
      );

    if (!result) {
      throw new HttpError.Unauthorized('Session not found or not accessible.');
    }

    res.code(200).send({
      sessionToken: result.sessionToken,
      sessionRefreshToken: result.sessionRefreshToken,
    });
  }

  async refreshSessionToken(
    req: BaseFastifyRequest<typeof REFRESH_SESSION_TOKEN_SCHEMA>,
    res: BaseFastifyReply<typeof REFRESH_SESSION_TOKEN_SCHEMA>,
  ) {
    const { sessionRefreshToken } = req.body;

    const result =
      await this._sessionManagementService.refreshSessionToken(
        sessionRefreshToken,
      );

    if (!result) {
      throw new HttpError.Unauthorized('Invalid or expired refresh token.');
    }

    res.code(200).send({ sessionToken: result.sessionToken });
  }

  async getSessionConfig(
    req: BaseFastifyRequest<typeof GET_SESSION_CONFIG_SCHEMA>,
    res: BaseFastifyReply<typeof GET_SESSION_CONFIG_SCHEMA>,
  ) {
    const { sessionId } = req.params;

    const result =
      await this._sessionManagementService.getSessionConfig(sessionId);

    if (!result) {
      throw new HttpError.NotFound('Session not found.');
    }

    res.code(200).send(result);
  }

  async endSession(
    req: BaseFastifyRequest<typeof END_SESSION_SCHEMA>,
    res: BaseFastifyReply<typeof END_SESSION_SCHEMA>,
  ) {
    const { sessionId } = req.body;

    const success = await this._sessionManagementService.endSession(sessionId);

    if (!success) {
      throw new HttpError.NotFound('Session not found or already ended.');
    }

    res.code(200).send({});
  }

  async getDeviceSessionEvents(
    req: BaseFastifyRequest<typeof DEVICE_SESSION_EVENTS_SCHEMA>,
    res: BaseFastifyReply<typeof DEVICE_SESSION_EVENTS_SCHEMA>,
  ) {
    const { prevEventId } = req.query;

    const event = await this._sessionManagementService.getDeviceSessionEvent(
      req.deviceId,
      prevEventId,
    );

    res.code(200).send(event ?? null);
  }
}
