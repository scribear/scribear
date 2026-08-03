import type {
  BaseFastifyReply,
  BaseFastifyRequest,
} from '@scribear/base-fastify-server';

import type { AppDependencies } from '#src/server/dependency-injection/app-dependencies.js';

import type { CONFIG_AUDIT_SCHEMA } from './config-audit.schema.js';

/**
 * Serves node-server's self-reported secret-placeholder classification
 * (PLAN-ConfigCheck-Coverage Phase 2), read straight off
 * `NodeStatusPollerService` rather than recomputed here — the classification
 * itself is entirely node-server's to make, this controller only relays it.
 *
 * `status` reflects the *most recent poll's* health, not merely whether a
 * classification has ever been seen: a consumer must be able to tell "node
 * server reports X" from "cannot currently ask node-server", and a stale
 * reading from before an outage started would blur exactly that
 * distinction.
 */
export class ConfigAuditController {
  private _nodeStatusPoller: AppDependencies['nodeStatusPollerService'];

  constructor(
    nodeStatusPollerService: AppDependencies['nodeStatusPollerService'],
  ) {
    this._nodeStatusPoller = nodeStatusPollerService;
  }

  configAudit(
    _req: BaseFastifyRequest<typeof CONFIG_AUDIT_SCHEMA>,
    res: BaseFastifyReply<typeof CONFIG_AUDIT_SCHEMA>,
  ) {
    const { enabled, lastResult, secretPlaceholders } = this._nodeStatusPoller;

    if (!enabled) {
      res
        .code(200)
        .send({ nodeServer: { status: 'unavailable', reason: 'disabled' } });
      return;
    }

    if (lastResult === null || !lastResult.ok || secretPlaceholders === null) {
      // The middle case (`!lastResult.ok`) is the common one in production —
      // an outage or a wrong key. The others narrow the same "not currently
      // safe to call this current" state: no poll has completed yet, or (this
      // should be unreachable, since `_apply` sets both together) a report
      // that claims success without a classification to go with it.
      res.code(200).send({
        nodeServer: {
          status: 'unavailable',
          // The `?? 'not-yet-polled'` only matters for the unreachable
          // ok-but-no-classification case above, where `lastResult.reason`
          // is null.
          reason:
            lastResult === null
              ? 'not-yet-polled'
              : (lastResult.reason ?? 'not-yet-polled'),
        },
      });
      return;
    }

    res.code(200).send({
      nodeServer: { status: 'ok', secretPlaceholders },
    });
  }
}
