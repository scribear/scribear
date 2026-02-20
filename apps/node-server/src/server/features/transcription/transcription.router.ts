import type { BaseFastifyInstance } from '@scribear/base-fastify-server';

import { authenticateWebsocket } from '../../hooks/authenticate-websocket.js';

/**
 * Registers WebSocket route for transcript delivery to students.
 * Students connect here and receive live transcripts as JSON messages.
 * @param fastify Fastify app instance (must be the parent, not encapsulated)
 */
function transcriptionRouter(fastify: BaseFastifyInstance) {
    fastify.get(
        '/transcription/:sessionId',
        { websocket: true, preHandler: authenticateWebsocket } as any,
        (socket, req) => {
            const controller = req.diScope.resolve('transcriptionController');
            controller.handleConnection(socket, req);
        },
    );
}

export default transcriptionRouter;
