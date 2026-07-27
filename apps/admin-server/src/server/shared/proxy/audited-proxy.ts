import type { FastifyReply, FastifyRequest } from 'fastify';

import type { AppDependencies } from '#src/server/dependency-injection/app-dependencies.js';

import type { GatewayResult } from '../services/session-manager-gateway.service.js';

/**
 * The part of a gateway this helper needs: something that can turn one
 * upstream call's result into an HTTP status, and send the matching envelope.
 *
 * Structural, rather than naming `sessionManagerGatewayService`, so that a
 * feature with an upstream of its own (`test-audio`) audits through this one
 * helper instead of growing a second copy of it. `SessionManagerGatewayService`
 * satisfies it as written.
 */
export interface MutationGateway<TResult> {
  classify(result: TResult): { httpStatus: number };
  respond(req: FastifyRequest, reply: FastifyReply, result: TResult): number;
}

/**
 * Run a mutating upstream call, send the mapped envelope, and write exactly one
 * audit record reflecting the outcome. Success/failure is derived from the same
 * HTTP status the caller receives (via `gateway.respond`), so audit and the
 * response never disagree.
 *
 * `paramsSummary` must contain ONLY non-sensitive fields (never secrets).
 */
export async function auditedMutation<TResult = GatewayResult>(params: {
  gateway: MutationGateway<TResult>;
  auditService: AppDependencies['auditService'];
  req: FastifyRequest;
  reply: FastifyReply;
  action: string;
  target: string | null;
  paramsSummary: Record<string, unknown>;
  call: () => Promise<TResult>;
}): Promise<void> {
  const { gateway, auditService, req, reply, action, target, paramsSummary } =
    params;

  const result = await params.call();
  const { httpStatus } = gateway.classify(result);

  // Persist the audit record BEFORE sending the response, so a recorded action
  // is durable by the time the client is told it succeeded (and so the two can
  // never disagree). `record` never throws.
  const identity = req.adminIdentity;
  await auditService.record({
    actorSubject: identity?.subject ?? 'unknown',
    actorProvider: identity?.provider ?? 'local',
    action,
    target,
    paramsSummary,
    result: httpStatus < 400 ? 'success' : 'failure',
    statusCode: httpStatus,
    requestId: req.id,
  });

  gateway.respond(req, reply, result);
}
