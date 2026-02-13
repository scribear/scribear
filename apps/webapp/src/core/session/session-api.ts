/**
 * API client for the session manager and node-server room endpoints.
 *
 * Kiosk flow:
 *   1. createSession()  → sessionId, joinCode
 *   2. createRoom()     → room with transcription config on node-server
 *   3. createToken(sessionId, secret, 'source') → JWT
 *
 * Client flow:
 *   1. createToken(joinCode, 'sink') → JWT + sessionId
 */

import { NODE_SERVER_URL, SESSION_MANAGER_URL } from '@/config/api-urls';

// ── Types ────────────────────────────────────────────────────

export interface CreateSessionResponse {
  sessionId: string;
  joinCode?: string;
  expiresAt: string;
}

export interface CreateTokenResponse {
  token: string;
  expiresIn: string;
  sessionId: string;
  scope: string;
}

export interface TranscriptionSessionConfig {
  providerKey?: string;
  useSsl?: boolean;
  sampleRate?: number;
  numChannels?: number;
}

export interface CreateRoomResponse {
  sessionId: string;
  transcriptionSessionConfig: Required<TranscriptionSessionConfig>;
  createdAt: string;
}

// ── Helpers ──────────────────────────────────────────────────

async function post<T>(url: string, body: object): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const data: unknown = await res.json();

  if (!res.ok) {
    const message =
      data && typeof data === 'object' && 'error' in data
        ? (data as { error: string }).error
        : `HTTP ${res.status.toString()}`;
    throw new Error(message);
  }

  return data as T;
}

// ── Session Manager API ──────────────────────────────────────

/**
 * Create a new session on the session manager.
 */
export async function createSession(
  audioSourceSecret: string,
  sessionLength = 3600,
): Promise<CreateSessionResponse> {
  return post<CreateSessionResponse>(
    `${SESSION_MANAGER_URL}/api/v1/session/create`,
    {
      sessionLength,
      audioSourceSecret,
      enableJoinCode: true,
      maxClients: 0,
    },
  );
}

/**
 * Get a JWT token for a session.
 *
 * For kiosk (source): pass sessionId + audioSourceSecret + scope 'source'
 * For client (sink):  pass joinCode + scope 'sink'
 */
export async function createToken(
  params:
    | {
        sessionId: string;
        audioSourceSecret: string;
        scope: 'source' | 'both';
      }
    | { joinCode: string; scope: 'sink' },
): Promise<CreateTokenResponse> {
  return post<CreateTokenResponse>(
    `${SESSION_MANAGER_URL}/api/v1/session/token`,
    params,
  );
}

// ── Node Server API ──────────────────────────────────────────

/**
 * Create a room on the node-server with transcription config.
 */
export async function createRoom(
  sessionId: string,
  transcriptionConfig?: TranscriptionSessionConfig,
): Promise<CreateRoomResponse> {
  return post<CreateRoomResponse>(`${NODE_SERVER_URL}/rooms`, {
    sessionId,
    transcriptionConfig,
  });
}
