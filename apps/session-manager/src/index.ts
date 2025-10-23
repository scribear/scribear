import AppConfig from './app_config/app_config.js';
import createServer from './server/create_server.js';

/**
 * Main entrypoint for session manager server
 */
async function main() {
  const config = new AppConfig();
  const { logger, fastify } = await createServer(config);

  // Handle uncaught exceptions and rejections
  process.on('uncaughtException', (err) => {
    logger.fatal({ msg: 'Uncaught exception', err });
    throw err; // terminate on uncaught errors
  });

  process.on('unhandledRejection', (reason) => {
    const err = Error('Unhandled rejection', { cause: reason });
    logger.fatal({ msg: 'Unhandled rejection', err });
    throw err; // terminate on uncaught rejection
  });

  try {
    await fastify.listen({ port: config.port, host: config.host });
  } catch (err) {
    logger.fatal({ msg: 'Failed to start fastify webserver', err });
    throw err; // terminate if failed to start
  }
}

await main();
