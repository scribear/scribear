import type { FastifyBaseLogger } from 'fastify';
import { pino, stdSerializers } from 'pino';

type BaseLogger = FastifyBaseLogger;

enum LogLevel {
  SILENT = 'silent',
  TRACE = 'trace',
  DEBUG = 'debug',
  INFO = 'info',
  WARN = 'warn',
  ERROR = 'error',
  FATAL = 'fatal',
}

/**
 * Creates a logger instance using app configuration
 * @param logLevel Minimum severity level that should be logged
 * @returns created logger
 */
function createLogger(logLevel: LogLevel): BaseLogger {
  const logger = pino({
    level: logLevel,
    serializers: { err: stdSerializers.errWithCause },
  });
  return logger;
}

export type { BaseLogger };
export { createLogger, LogLevel };
