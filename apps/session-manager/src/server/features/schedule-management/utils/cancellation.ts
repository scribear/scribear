/** Result of `assertCancelable`. `'OK'` means the session may be canceled. */
export type CancelEligibility =
  | 'OK'
  | 'SESSION_NOT_SCHEDULED_TYPE'
  | 'SESSION_ALREADY_CANCELED'
  | 'SESSION_NOT_UPCOMING';

/** The subset of a `Session` that `assertCancelable` needs. */
export interface CancellableSession {
  type: 'SCHEDULED' | 'ON_DEMAND' | 'AUTO';
  canceledAt: Date | null;
  startOverride: Date | null;
  scheduledStartTime: Date;
}

/**
 * Determines whether a session may be canceled: it must be a `SCHEDULED`
 * occurrence, not already canceled, and still upcoming (its effective start
 * strictly after `now`).
 */
export function assertCancelable(
  session: CancellableSession,
  now: Date,
): CancelEligibility {
  if (session.type !== 'SCHEDULED') return 'SESSION_NOT_SCHEDULED_TYPE';
  if (session.canceledAt !== null) return 'SESSION_ALREADY_CANCELED';
  const effectiveStart = session.startOverride ?? session.scheduledStartTime;
  if (effectiveStart <= now) return 'SESSION_NOT_UPCOMING';
  return 'OK';
}

/**
 * Determines whether a canceled session may be uncanceled: it must actually
 * be canceled. (Whether the freed slot is still available is a separate,
 * DB-level check — see `isPgExclusionViolation`.)
 */
export function assertUncancelable(
  session: Pick<CancellableSession, 'canceledAt'>,
): 'OK' | 'SESSION_NOT_CANCELED' {
  return session.canceledAt !== null ? 'OK' : 'SESSION_NOT_CANCELED';
}
