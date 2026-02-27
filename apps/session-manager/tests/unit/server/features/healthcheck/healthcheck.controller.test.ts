import { type Mock, beforeEach, describe, expect, vi } from 'vitest';

import { HealthcheckController } from '#src/server/features/healthcheck/healthcheck.controller.js';

describe('Healthcheck controller', (it) => {
  const testRequestId = 'TEST_REQUEST_ID';
  let mockReply: {
    send: Mock;
    code: Mock;
    header: Mock;
  };

  let healthcheckController: HealthcheckController;

  beforeEach(() => {
    mockReply = {
      send: vi.fn(),
      code: vi.fn().mockReturnThis(),
      header: vi.fn().mockReturnThis(),
    };

    healthcheckController = new HealthcheckController();
  });

  it('responds with request id', () => {
    // Arrange
    const mockReq = { id: testRequestId };

    // Act
    healthcheckController.healthcheck(mockReq as never, mockReply as never);

    // Assert
    expect(mockReply.code).toHaveBeenCalledExactlyOnceWith(200);
    expect(mockReply.send).toHaveBeenCalledExactlyOnceWith({
      reqId: testRequestId,
    });
  });
});
