import type { BaseLogger } from '@scribear/base-fastify-server';

/**
 * A logger that records nothing.
 *
 * The runner logs on every state change, which is right in production and pure
 * noise in a suite that asserts on the state rather than on the log line.
 */
export function silentLogger(): BaseLogger {
  const noop = () => {
    // Intentionally empty.
  };
  const logger = {
    fatal: noop,
    error: noop,
    warn: noop,
    info: noop,
    debug: noop,
    trace: noop,
    silent: noop,
    level: 'silent',
    child: () => logger,
  };
  return logger;
}
