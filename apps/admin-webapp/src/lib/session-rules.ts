import type { Session } from '@scribear/session-manager-schema';

export type SessionColor = 'info' | 'default' | 'success';

export function sessionTypeColor(type: Session['type']): SessionColor {
  if (type === 'SCHEDULED') return 'info';
  if (type === 'ON_DEMAND') return 'success';
  return 'default'; // AUTO
}
