import type {
    BaseFastifyReply,
    BaseFastifyRequest,
} from '@scribear/base-fastify-server';

import type { AppDependencies } from '../../dependency-injection/register-dependencies.js';

/**
 * Healthcheck route schema (inline for now since node-server doesn't have its own schema lib yet)
 */
const HEALTHCHECK_SCHEMA = {
    response: {
        200: {
            type: 'object' as const,
            properties: {
                reqId: { type: 'string' as const },
                status: { type: 'string' as const },
            },
        },
    },
};

class HealthcheckController {
    private _roomManagerService: AppDependencies['roomManagerService'];

    constructor(roomManagerService: AppDependencies['roomManagerService']) {
        this._roomManagerService = roomManagerService;
    }

    healthcheck(
        req: BaseFastifyRequest<typeof HEALTHCHECK_SCHEMA>,
        res: BaseFastifyReply<typeof HEALTHCHECK_SCHEMA>,
    ) {
        res.code(200).send({
            reqId: req.id,
            status: 'ok',
        });
    }
}

export default HealthcheckController;
