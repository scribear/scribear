import type { SessionScope } from '@scribear/session-manager-schema';

import type { SessionTokenService } from '#src/server/shared/services/session-token.service.js';

export type TranscriptionStreamRole = 'source' | 'client';

const REQUIRED_SCOPE: Record<TranscriptionStreamRole, SessionScope> = {
  source: 'SEND_AUDIO',
  client: 'RECEIVE_TRANSCRIPTIONS',
};

export interface AuthSuccess {
  ok: true;
}

export interface AuthFailure {
  ok: false;
  code: number;
  reason: string;
}

export type AuthResult = AuthSuccess | AuthFailure;

/**
 * Verify a presented session token against the role-specific scope and the
 * sessionUid pinned to the URL. Returns a structured success/failure so the
 * controller can translate the failure into a WebSocket close frame without
 * embedding any auth-protocol knowledge inline.
 */
export function verifyAuth(
  role: TranscriptionStreamRole,
  urlSessionUid: string,
  token: string,
  sessionTokenService: SessionTokenService,
): AuthResult {
  const payload = sessionTokenService.verify(token);
  if (payload === null) {
    return { ok: false, code: 1008, reason: 'invalid-token' };
  }

  if (payload.exp * 1000 < Date.now()) {
    return { ok: false, code: 1008, reason: 'token-expired' };
  }

  if (payload.sessionUid !== urlSessionUid) {
    return { ok: false, code: 1008, reason: 'session-mismatch' };
  }

  if (!payload.scopes.includes(REQUIRED_SCOPE[role])) {
    return { ok: false, code: 1008, reason: 'missing-scope' };
  }

  return { ok: true };
}
