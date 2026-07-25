import type { Session } from '@scribear/session-manager-schema';

export type SessionColor = 'info' | 'default' | 'success';

export function sessionTypeColor(type: Session['type']): SessionColor {
  if (type === 'SCHEDULED') return 'info';
  if (type === 'ON_DEMAND') return 'success';
  return 'default'; // AUTO
}

/**
 * Where `now` sits relative to a session's scheduled window.
 *
 * `within` is the only state in which live pipeline telemetry is *expected*, so
 * it is the only state in which its absence is a finding. A `Session` from
 * schedule-management carries no live flag — it is a scheduled record, and the
 * detail page is reachable for a session that finished last term as readily as
 * for one running right now — so this is the closest thing to "should this be on
 * the air?" available without a fleet lookup.
 */
export type SessionWindowState = 'before' | 'within' | 'after';

/**
 * Classifies a session against its effective window.
 *
 * `effectiveEnd` is nullable (an open-ended session), in which case anything at
 * or after `effectiveStart` is `within` — an open-ended session never reads as
 * `after`. An unparseable timestamp falls through to `within` rather than
 * suppressing telemetry that may well be real.
 */
export function sessionWindowState(
  session: Pick<Session, 'effectiveStart' | 'effectiveEnd'>,
  now: number,
): SessionWindowState {
  const start = Date.parse(session.effectiveStart);
  if (Number.isFinite(start) && now < start) return 'before';

  if (session.effectiveEnd !== null) {
    const end = Date.parse(session.effectiveEnd);
    if (Number.isFinite(end) && now > end) return 'after';
  }

  return 'within';
}
