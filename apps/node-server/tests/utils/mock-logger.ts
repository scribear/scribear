import { type Mock, vi } from 'vitest';

export interface MockLogger {
  trace: Mock;
  debug: Mock;
  info: Mock;
  warn: Mock;
  error: Mock;
  fatal: Mock;
  child: Mock;
}

/**
 * Creates a mock logger for use in unit tests.
 *
 * @returns A mock logger with all methods stubbed via vi.fn().
 */
export function createMockLogger(): MockLogger {
  const logger: MockLogger = {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
  };
  logger.child.mockReturnValue(logger);
  return logger;
}
