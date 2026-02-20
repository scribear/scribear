import type { BaseFastifyInstance } from '@scribear/base-fastify-server';

import { authenticateWebsocket } from '../../hooks/authenticate-websocket.js';

/**
 * Registers WebSocket route for audio ingestion from kiosks.
 * Kiosks connect here and send binary audio frames.
 * @param fastify Fastify app instance (must be the parent, not encapsulated)
 */
function audioRouter(fastify: BaseFastifyInstance) {
    fastify.get(
        '/audio/:sessionId',
        { websocket: true, preHandler: authenticateWebsocket } as any,
        (socket, req) => {
            const controller = req.diScope.resolve('audioController');
            controller.handleConnection(socket, req);
        },
    );
}

export default audioRouter;
