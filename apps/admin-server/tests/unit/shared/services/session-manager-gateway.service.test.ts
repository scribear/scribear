import { describe, expect } from 'vitest';

import {
  NetworkError,
  UnexpectedResponseError,
} from '@scribear/base-api-client';

import { SessionManagerGatewayService } from '#src/server/shared/services/session-manager-gateway.service.js';
import type { GatewayResult } from '#src/server/shared/services/session-manager-gateway.service.js';

describe('SessionManagerGatewayService', () => {
  describe('classify', (it) => {
    const service = new SessionManagerGatewayService({
      adminApiKey: 'k',
      sessionManagerBaseUrl: 'http://sm.test',
    });

    it('maps a 200 response to an ok outcome carrying the response data', () => {
      // Arrange
      const result: GatewayResult = [{ status: 200, data: { a: 1 } }, null];

      // Act
      const outcome = service.classify(result);

      // Assert
      expect(outcome).toMatchObject({
        httpStatus: 200,
        ok: true,
        data: { a: 1 },
      });
    });

    it('maps a 201 response to an ok outcome preserving the status', () => {
      // Arrange
      const result: GatewayResult = [{ status: 201, data: { uid: 'x' } }, null];

      // Act
      const outcome = service.classify(result);

      // Assert
      expect(outcome).toMatchObject({ httpStatus: 201, ok: true });
    });

    it('normalizes a 204 response to a 200 ok outcome with null data', () => {
      // Arrange
      const result: GatewayResult = [{ status: 204, data: null }, null];

      // Act
      const outcome = service.classify(result);

      // Assert
      expect(outcome).toMatchObject({ httpStatus: 200, ok: true, data: null });
    });

    it('passes through a declared 404 with its code', () => {
      // Arrange
      const result: GatewayResult = [
        { status: 404, data: { code: 'ROOM_NOT_FOUND', message: 'nope' } },
        null,
      ];

      // Act
      const outcome = service.classify(result);

      // Assert
      expect(outcome).toMatchObject({
        httpStatus: 404,
        ok: false,
        code: 'ROOM_NOT_FOUND',
      });
    });

    it('passes through a declared 409 with its code', () => {
      // Arrange
      const result: GatewayResult = [
        { status: 409, data: { code: 'DEVICE_ALREADY_IN_ROOM', message: 'x' } },
        null,
      ];

      // Act
      const outcome = service.classify(result);

      // Assert
      expect(outcome).toMatchObject({
        httpStatus: 409,
        ok: false,
        code: 'DEVICE_ALREADY_IN_ROOM',
      });
    });

    it('maps an upstream 401 to a 502 BACKEND_MISCONFIGURATION rather than passing 401 through', () => {
      // Arrange
      const result: GatewayResult = [
        { status: 401, data: { code: 'INVALID_ADMIN_KEY', message: 'x' } },
        null,
      ];

      // Act
      const outcome = service.classify(result);

      // Assert
      expect(outcome).toMatchObject({
        httpStatus: 502,
        ok: false,
        code: 'BACKEND_MISCONFIGURATION',
      });
    });

    it('maps an UnexpectedResponseError with status 429 to RATE_LIMITED', () => {
      // Arrange
      const result: GatewayResult = [null, new UnexpectedResponseError(429)];

      // Act
      const outcome = service.classify(result);

      // Assert
      expect(outcome).toMatchObject({
        httpStatus: 429,
        ok: false,
        code: 'RATE_LIMITED',
      });
    });

    it('maps an UnexpectedResponseError with status 503 to a 502 UPSTREAM_ERROR', () => {
      // Arrange
      const result: GatewayResult = [null, new UnexpectedResponseError(503)];

      // Act
      const outcome = service.classify(result);

      // Assert
      expect(outcome).toMatchObject({
        httpStatus: 502,
        ok: false,
        code: 'UPSTREAM_ERROR',
      });
    });

    it('maps a NetworkError to a 503 UPSTREAM_UNREACHABLE', () => {
      // Arrange
      const result: GatewayResult = [null, new NetworkError(new Error('boom'))];

      // Act
      const outcome = service.classify(result);

      // Assert
      expect(outcome).toMatchObject({
        httpStatus: 503,
        ok: false,
        code: 'UPSTREAM_UNREACHABLE',
      });
    });
  });
});
