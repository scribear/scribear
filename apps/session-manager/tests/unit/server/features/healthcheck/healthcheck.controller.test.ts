import { type Mock, beforeEach, describe, expect, vi } from 'vitest';

import type {
  BaseFastifyReply,
  BaseFastifyRequest,
} from '@scribear/base-fastify-server';
import type { HealthcheckSchema } from '@scribear/session-manager-schema';

import HealthcheckController from '../../../../../src/server/features/healthcheck/healthcheck.controller.js';

describe('Healthcheck controller', (it) => {
  const testRequestId = 'TEST_REQUEST_ID';
  let mockReply: {
    send: Mock;
    code: Mock;
  };

  let healthcheckController: HealthcheckController;

  beforeEach(() => {
    mockReply = {
      send: vi.fn(),
      code: vi.fn().mockReturnThis(),
    };

    healthcheckController = new HealthcheckController();
  });

  it('responds with request id', () => {
    // Arrange
    const mockReq = { id: testRequestId };

    // Act
    healthcheckController.healthcheck(
      mockReq as unknown as BaseFastifyRequest<typeof HealthcheckSchema>,
      mockReply as unknown as BaseFastifyReply<typeof HealthcheckSchema>,
    );

    // Assert
    expect(mockReply.code).toHaveBeenCalledExactlyOnceWith(200);
    expect(mockReply.send).toHaveBeenCalledExactlyOnceWith({
      reqId: testRequestId,
    });
  });
});
