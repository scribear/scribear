import type {
    BaseFastifyReply,
    BaseFastifyRequest,
} from '@scribear/base-fastify-server';

import type { AppDependencies } from '../../dependency-injection/register-dependencies.js';
import type { TranscriptionSessionConfig } from '../../services/room-manager.service.js';

interface CreateRoomBody {
    sessionId: string;
    transcriptionConfig?: Partial<TranscriptionSessionConfig>;
}

class RoomController {
    private _roomManagerService: AppDependencies['roomManagerService'];

    constructor(roomManagerService: AppDependencies['roomManagerService']) {
        this._roomManagerService = roomManagerService;
    }

    /**
     * Create a room with optional transcription config.
     * If the room already exists, returns 409 Conflict.
     */
    createRoom(req: BaseFastifyRequest<object>, res: BaseFastifyReply<object>) {
        const { sessionId, transcriptionConfig } = req.body as CreateRoomBody;

        const existing = this._roomManagerService.getRoom(sessionId);
        if (existing) {
            res.code(409).send({ error: 'Room already exists for this session' });
            return;
        }

        const room = this._roomManagerService.createRoom(
            sessionId,
            transcriptionConfig,
        );

        res.code(201).send({
            sessionId: room.sessionId,
            transcriptionSessionConfig: room.transcriptionSessionConfig,
            createdAt: room.createdAt,
        });
    }

    /**
     * List all active rooms
     */
    listRooms(req: BaseFastifyRequest<object>, res: BaseFastifyReply<object>) {
        const rooms = this._roomManagerService.listRooms();
        res.code(200).send({
            rooms,
            count: rooms.length,
        });
    }

    /**
     * Get info for a specific room
     */
    getRoom(req: BaseFastifyRequest<object>, res: BaseFastifyReply<object>) {
        const { sessionId } = req.params as { sessionId: string };
        const room = this._roomManagerService.getRoom(sessionId);

        if (!room) {
            res.code(404).send({ error: 'Room not found' });
            return;
        }

        res.code(200).send({
            sessionId: room.sessionId,
            hasSource: room.sourceSocket !== null,
            subscriberCount: room.subscribers.size,
            createdAt: room.createdAt,
            transcriptionConnected: room.transcriptionClient !== null,
            transcriptionSessionConfig: room.transcriptionSessionConfig,
        });
    }
}

export default RoomController;
