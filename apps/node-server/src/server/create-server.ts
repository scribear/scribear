import cors from '@fastify/cors';
import { createBaseServer } from '@scribear/base-fastify-server';

import type AppConfig from '../app-config/app-config.js';
import registerDependencies from './dependency-injection/register-dependencies.js';
import audioRouter from './features/audio/audio.router.js';
import healthcheckRouter from './features/healthcheck/healthcheck.router.js';
import roomRouter from './features/room/room.router.js';
import transcriptionRouter from './features/transcription/transcription.router.js';
import swagger from './plugins/swagger.js';
import websocket from './plugins/websocket.js';

/**
 * Initializes fastify server and registers dependencies
 * @param config Application config
 * @returns Initialized fastify server
 */
async function createServer(config: AppConfig) {
    const { logger, dependencyContainer, fastify } = createBaseServer(
        config.baseConfig.logLevel,
    );

    // Enable CORS so the webapp (different origin) can call our API
    await fastify.register(cors, { origin: true });

    // Register WebSocket support
    await fastify.register(websocket);

    // Only include swagger docs if in development mode
    if (config.baseConfig.isDevelopment) {
        await fastify.register(swagger);
    }

    registerDependencies(dependencyContainer, config);

    // Register REST routes (encapsulated is fine)
    fastify.register(healthcheckRouter);
    fastify.register(roomRouter);

    // WebSocket routes must be registered directly on the parent instance,
    // not via fastify.register(), because @fastify/websocket's onRoute hook
    // only fires in the context where the plugin was registered.
    audioRouter(fastify);
    transcriptionRouter(fastify);

    return { logger, fastify };
}

export default createServer;
