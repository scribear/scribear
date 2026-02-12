import type { BaseFastifyInstance } from '@scribear/base-fastify-server';

import { authenticateWebsocket } from '../../hooks/authenticate-websocket.js';

/**
 * Registers WebSocket route for transcript delivery to students.
 * Students connect here and receive live transcripts as JSON messages.
 * @param fastify Fastify app instance
 */
function transcriptionRouter(fastify: BaseFastifyInstance) {
    // WebSocket handler for transcript subscription
    // Uses @fastify/websocket v11 API: { websocket: true }
    fastify.get(
        '/transcription/:sessionId',
        { websocket: true, preHandler: authenticateWebsocket } as any,
        (socket, req) => {
            const { sessionId } = req.params as { sessionId: string };
            const jwtPayload = req.jwtPayload;

            // Verify the token scope allows transcript sink access
            if (jwtPayload?.scope !== 'sink' && jwtPayload?.scope !== 'both') {
                req.log.warn(
                    { sessionId, scope: jwtPayload?.scope },
                    'Unauthorized scope for transcript subscription',
                );
                socket.close(4003, 'Unauthorized: token scope does not allow transcript access');
                return;
            }

            // Add this socket as a subscriber
            const roomManagerService = req.diScope.resolve('roomManagerService');
            roomManagerService.addSubscriber(sessionId, socket);

            req.log.info({ sessionId }, 'Student subscriber connected');

            socket.on('close', (code: number, reason: Buffer) => {
                req.log.info(
                    { sessionId, code, reason: reason.toString() },
                    'Student subscriber disconnected',
                );
                roomManagerService.removeSubscriber(sessionId, socket);
            });

            socket.on('error', (error: Error) => {
                req.log.error(
                    { sessionId, error: error.message },
                    'Subscriber socket error',
                );
            });
        },
    );
}

export default transcriptionRouter;
