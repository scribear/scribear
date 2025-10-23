import { pino, stdSerializers } from 'pino';
import type { Logger } from 'pino';

// Alias type to decouple log provider from application
type BaseLogger = Logger;

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
