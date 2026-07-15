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
