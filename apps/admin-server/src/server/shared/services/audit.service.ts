import type { AppDependencies } from '#src/server/dependency-injection/app-dependencies.js';

import type { AuditRecordInput } from '../repositories/audit.repository.js';

/**
 * Writes the audit trail for admin actions. Every mutating action is recorded
 * with actor / action / target / params-summary / result / requestId.
 *
 * Guarantees:
 * - A DB write failure NEVER fails the request (the action already happened
 *   upstream); it is logged loudly instead.
 * - `paramsSummary` is caller-provided and must never contain secrets
 *   (passwords, tokens, the admin key). Callers pass only non-sensitive fields.
 */
export class AuditService {
  private _logger: AppDependencies['logger'];
  private _auditRepository: AppDependencies['auditRepository'];

  constructor(
    logger: AppDependencies['logger'],
    auditRepository: AppDependencies['auditRepository'],
  ) {
    this._logger = logger;
    this._auditRepository = auditRepository;
  }

  async record(input: AuditRecordInput): Promise<void> {
    // Structured log line for the existing logging pipeline (always emitted).
    this._logger.info(
      {
        audit: {
          actor: input.actorSubject,
          provider: input.actorProvider,
          action: input.action,
          target: input.target,
          result: input.result,
          statusCode: input.statusCode,
          requestId: input.requestId,
        },
      },
      'admin action',
    );

    try {
      await this._auditRepository.insert(input);
    } catch (err) {
      this._logger.error(
        { err, action: input.action, requestId: input.requestId },
        'Failed to persist audit record',
      );
    }
  }
}
