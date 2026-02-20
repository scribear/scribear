import type { FastifyRequest } from 'fastify';
import type WebSocket from 'ws';

import type { AppDependencies } from '../../dependency-injection/register-dependencies.js';

/**
 * Handles WebSocket connections for transcript delivery to students.
 * Validates scope, registers subscribers, and manages cleanup.
 */
class TranscriptionController {
    private _roomManagerService: AppDependencies['roomManagerService'];

    constructor(roomManagerService: AppDependencies['roomManagerService']) {
        this._roomManagerService = roomManagerService;
    }

    /**
     * Handle a new transcript subscriber WebSocket connection.
     * @param socket The WebSocket connection
     * @param req The originating Fastify request (already authenticated)
     */
    handleConnection(socket: WebSocket, req: FastifyRequest) {
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
        this._roomManagerService.addSubscriber(sessionId, socket);

        req.log.info({ sessionId }, 'Student subscriber connected');

        socket.on('close', (code: number, reason: Buffer) => {
            req.log.info(
                { sessionId, code, reason: reason.toString() },
                'Student subscriber disconnected',
            );
            this._roomManagerService.removeSubscriber(sessionId, socket);
        });

        socket.on('error', (error: Error) => {
            req.log.error(
                { sessionId, error: error.message },
                'Subscriber socket error',
            );
        });
    }
}

export default TranscriptionController;
