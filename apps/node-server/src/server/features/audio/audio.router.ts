import type { BaseFastifyInstance } from '@scribear/base-fastify-server';

import { authenticateWebsocket } from '../../hooks/authenticate-websocket.js';

/**
 * Registers WebSocket route for audio ingestion from kiosks.
 * Kiosks connect here and send binary audio frames.
 * @param fastify Fastify app instance
 */
function audioRouter(fastify: BaseFastifyInstance) {
    // WebSocket handler for audio ingestion
    // Uses @fastify/websocket v11 API: { websocket: true }
    fastify.get(
        '/audio/:sessionId',
        { websocket: true, preHandler: authenticateWebsocket } as any,
        (socket, req) => {
            const { sessionId } = req.params as { sessionId: string };
            const jwtPayload = req.jwtPayload;

            // Verify the token scope allows audio source access
            if (jwtPayload?.scope !== 'source' && jwtPayload?.scope !== 'both') {
                req.log.warn(
                    { sessionId, scope: jwtPayload?.scope },
                    'Unauthorized scope for audio source',
                );
                socket.close(4003, 'Unauthorized: token scope does not allow audio source access');
                return;
            }

            // Try to set this socket as the audio source for the room
            const roomManagerService = req.diScope.resolve('roomManagerService');
            const success = roomManagerService.setAudioSource(sessionId, socket);

            if (!success) {
                req.log.warn({ sessionId }, 'Room already has an audio source');
                socket.close(4001, 'Room already has an audio source');
                return;
            }

            req.log.info({ sessionId }, 'Kiosk audio source connected');

            // Forward binary audio data to transcription service
            socket.on('message', (data: Buffer, isBinary: boolean) => {
                if (isBinary) {
                    roomManagerService.forwardAudio(sessionId, data);
                } else {
                    req.log.debug({ sessionId }, 'Received non-binary message from audio source');
                }
            });

            socket.on('close', (code: number, reason: Buffer) => {
                req.log.info(
                    { sessionId, code, reason: reason.toString() },
                    'Kiosk audio source disconnected',
                );
                roomManagerService.removeAudioSource(sessionId);
            });

            socket.on('error', (error: Error) => {
                req.log.error(
                    { sessionId, error: error.message },
                    'Audio source socket error',
                );
            });
        },
    );
}

export default audioRouter;
