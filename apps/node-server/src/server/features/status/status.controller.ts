import type {
  BaseFastifyReply,
  BaseFastifyRequest,
} from '@scribear/base-fastify-server';
import {
  STATUS_MAX_SESSIONS,
  type STATUS_SCHEMA,
} from '@scribear/node-server-schema';

import type { AppDependencies } from '#src/server/dependency-injection/app-dependencies.js';

/**
 * Serves the process telemetry snapshot consumed by the Monitoring Sidecar
 * (monitoring plan B1.1), replacing the log-text inference it used before.
 *
 * Purely a transport step: the numbers and the join that produces them belong
 * to {@link StatusSnapshotService}, which the Redis telemetry publisher reads
 * the same way (B1.7), so this controller is in nobody's path but HTTP's.
 */
export class StatusController {
  private _snapshots: AppDependencies['statusSnapshotService'];
  private _secretPlaceholders: AppDependencies['secretPlaceholders'];

  constructor(
    statusSnapshotService: AppDependencies['statusSnapshotService'],
    secretPlaceholders: AppDependencies['secretPlaceholders'],
  ) {
    this._snapshots = statusSnapshotService;
    this._secretPlaceholders = secretPlaceholders;
  }

  status(
    _req: BaseFastifyRequest<typeof STATUS_SCHEMA>,
    res: BaseFastifyReply<typeof STATUS_SCHEMA>,
  ) {
    const { sessions, truncated } =
      this._snapshots.sessions(STATUS_MAX_SESSIONS);

    res.code(200).send({
      ...this._snapshots.process(),
      sessions,
      sessionsTruncated: truncated,
      secretPlaceholders: this._secretPlaceholders,
    });
  }
}
