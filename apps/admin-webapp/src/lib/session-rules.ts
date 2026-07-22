import type { Session } from '@scribear/session-manager-schema';

export type SessionColor = 'info' | 'default' | 'success';

export function sessionTypeColor(type: Session['type']): SessionColor {
  if (type === 'SCHEDULED') return 'info';
  if (type === 'ON_DEMAND') return 'success';
  return 'default'; // AUTO
}

/** Mirrors the backend's `assertCancelable` rule (session-manager `utils/cancellation.ts`). */
export function canCancel(session: Session, now: Date): boolean {
  if (session.type !== 'SCHEDULED') return false;
  if (session.canceledAt !== null) return false;
  const effectiveStart = session.startOverride
    ? new Date(session.startOverride)
    : new Date(session.scheduledStartTime);
  return effectiveStart > now;
}

/**
 * Type check only, for button-gating — "is this the single next upcoming
 * session in the room" requires comparing against sibling sessions and is
 * intentionally left to the server's 409 (`NOT_NEXT_UPCOMING`).
 */
export function canStartEarly(session: Session, now: Date): boolean {
  const effectiveStart = session.startOverride
    ? new Date(session.startOverride)
    : new Date(session.scheduledStartTime);
  return session.type !== 'AUTO' && effectiveStart > now;
}

export function canEndEarly(session: Session, now: Date): boolean {
  const effectiveStart = session.startOverride
    ? new Date(session.startOverride)
    : new Date(session.scheduledStartTime);
  const effectiveEnd = session.endOverride
    ? new Date(session.endOverride)
    : session.scheduledEndTime
      ? new Date(session.scheduledEndTime)
      : null;
  const started = effectiveStart <= now;
  const notEnded = effectiveEnd === null || effectiveEnd > now;
  return session.type !== 'AUTO' && started && notEnded;
}
