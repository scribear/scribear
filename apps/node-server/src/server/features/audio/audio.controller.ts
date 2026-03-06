import type { FastifyRequest } from 'fastify';
import type WebSocket from 'ws';

import type { AppDependencies } from '../../dependency-injection/register-dependencies.js';

/**
 * Handles WebSocket connections for audio ingestion from kiosks.
 * Validates scope, wires up audio forwarding, and manages cleanup.
 */
class AudioController {
    private _roomManagerService: AppDependencies['roomManagerService'];

    constructor(roomManagerService: AppDependencies['roomManagerService']) {
        this._roomManagerService = roomManagerService;
    }

    /**
     * Handle a new audio source WebSocket connection.
     * @param socket The WebSocket connection
     * @param req The originating Fastify request (already authenticated)
     */
    handleConnection(socket: WebSocket, req: FastifyRequest) {
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
        const success = this._roomManagerService.setAudioSource(sessionId, socket);

        if (!success) {
            req.log.warn({ sessionId }, 'Room already has an audio source');
            socket.close(4001, 'Room already has an audio source');
            return;
        }

        req.log.info({ sessionId }, 'Kiosk audio source connected');

        // Forward binary audio data to transcription service
        socket.on('message', (data: Buffer, isBinary: boolean) => {
            if (isBinary) {
                this._roomManagerService.forwardAudio(sessionId, data);
            } else {
                req.log.debug({ sessionId }, 'Received non-binary message from audio source');
            }
        });

        socket.on('close', (code: number, reason: Buffer) => {
            req.log.info(
                { sessionId, code, reason: reason.toString() },
                'Kiosk audio source disconnected',
            );
            this._roomManagerService.removeAudioSource(sessionId);
        });

        socket.on('error', (error: Error) => {
            req.log.error(
                { sessionId, error: error.message },
                'Audio source socket error',
            );
        });
    }
}

export default AudioController;
