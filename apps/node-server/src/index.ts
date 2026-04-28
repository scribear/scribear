import { AppConfig } from './app-config/app-config.js';
import createServer from './server/create-server.js';

async function main() {
  const config = new AppConfig();
  const { logger, fastify } = await createServer(config);

  process.on('uncaughtException', (err) => {
    logger.fatal({ msg: 'Uncaught exception', err });
    throw err;
  });

  process.on('unhandledRejection', (reason) => {
    const err = Error('Unhandled rejection', { cause: reason });
    logger.fatal({ msg: 'Unhandled rejection', err });
    throw err;
  });

  try {
    await fastify.listen({
      port: config.baseConfig.port,
      host: config.baseConfig.host,
    });
  } catch (err) {
    logger.fatal({ msg: 'Failed to start fastify webserver', err });
    throw err;
  }
}

await main();
