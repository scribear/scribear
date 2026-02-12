import type {
    BaseFastifyReply,
    BaseFastifyRequest,
} from '@scribear/base-fastify-server';

import type { AppDependencies } from '../../dependency-injection/register-dependencies.js';

class RoomController {
    private _roomManagerService: AppDependencies['roomManagerService'];

    constructor(roomManagerService: AppDependencies['roomManagerService']) {
        this._roomManagerService = roomManagerService;
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
        });
    }
}

export default RoomController;
