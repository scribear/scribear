import bcrypt from 'bcrypt';
import { randomBytes } from 'node:crypto';

import type { AppDependencies } from '@/server/dependency-injection/register-dependencies.js';

const SALT_ROUNDS = 10;

export interface Session {
  sessionId: string;
  sessionLength: number;
  maxClients: number;
  enableJoinCode: boolean;
  joinCode?: string | undefined;
  audioSourceSecretHash: string;
  createdAt: Date;
  expiresAt: Date;
}

export interface CreateSessionParams {
  sessionLength: number;
  maxClients?: number | undefined;
  enableJoinCode?: boolean | undefined;
  audioSourceSecret: string;
}

// This is currently in-memory, we can override these functions to save to prisma/KV-store later
export class SessionService {
  private _log: AppDependencies['logger'];
  private _sessions: Map<string, Session>;
  private _joinCodeToSessionId: Map<string, string>;

  constructor(logger: AppDependencies['logger']) {
    this._log = logger;
    this._sessions = new Map();
    this._joinCodeToSessionId = new Map();
  }

  /**
   * Create a new session
   */
  async createSession(params: CreateSessionParams): Promise<Session> {
    const sessionId = this._generateSessionId();
    const joinCode = params.enableJoinCode
      ? this._generateJoinCode()
      : undefined;

    const audioSourceSecretHash = await bcrypt.hash(
      params.audioSourceSecret,
      SALT_ROUNDS,
    );

    const createdAt = new Date();
    const expiresAt = new Date(
      createdAt.getTime() + params.sessionLength * 1000,
    );

    const session: Session = {
      sessionId,
      sessionLength: params.sessionLength,
      maxClients: params.maxClients ?? 0,
      enableJoinCode: params.enableJoinCode ?? false,
      joinCode,
      audioSourceSecretHash,
      createdAt,
      expiresAt,
    };

    this._sessions.set(sessionId, session);

    if (joinCode) {
      this._joinCodeToSessionId.set(joinCode, sessionId);
    }

    this._log.info(
      { sessionId, joinCode, expiresAt },
      'Session created successfully',
    );

    // Schedule session cleanup
    setTimeout(() => {
      this._cleanupSession(sessionId);
    }, params.sessionLength * 1000);

    return session;
  }

  /**
   * Get session by session ID
   */
  getSession(sessionId: string): Session | undefined {
    const session = this._sessions.get(sessionId);

    if (session && this._isSessionExpired(session)) {
      this._cleanupSession(sessionId);
      return undefined;
    }

    return session;
  }

  /**
   * Get session by join code
   */
  getSessionByJoinCode(joinCode: string): Session | undefined {
    const sessionId = this._joinCodeToSessionId.get(joinCode);

    if (!sessionId) {
      return undefined;
    }

    return this.getSession(sessionId);
  }

  /**
   * Verify audio source secret for a session
   */
  async verifyAudioSourceSecret(
    sessionId: string,
    audioSourceSecret: string,
  ): Promise<boolean> {
    const session = this.getSession(sessionId);

    if (!session) {
      this._log.warn(
        { sessionId },
        'Session not found for secret verification',
      );
      return false;
    }

    const isValid = await bcrypt.compare(
      audioSourceSecret,
      session.audioSourceSecretHash,
    );

    if (!isValid) {
      this._log.warn({ sessionId }, 'Invalid audio source secret');
    }

    return isValid;
  }

  /**
   * Check if session exists and is valid
   */
  isSessionValid(sessionId: string): boolean {
    const session = this.getSession(sessionId);
    return session !== undefined && !this._isSessionExpired(session);
  }

  /**
   * Generate a unique session ID
   */
  private _generateSessionId(): string {
    return `session_${randomBytes(16).toString('hex')}`;
  }

  /**
   * Generate a random join code (8 characters, alphanumeric)
   */
  private _generateJoinCode(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let joinCode = '';

    for (let i = 0; i < 8; i++) {
      const byte = randomBytes(1).readUInt8(0);
      const randomIndex = byte % chars.length;
      const char = chars.charAt(randomIndex);
      joinCode += char;
    }

    return joinCode;
  }

  /**
   * Check if a session has expired
   */
  private _isSessionExpired(session: Session): boolean {
    return new Date() > session.expiresAt;
  }

  /**
   * Clean up expired session
   */
  private _cleanupSession(sessionId: string): void {
    const session = this._sessions.get(sessionId);

    if (!session) {
      return;
    }

    if (session.joinCode !== undefined) {
      this._joinCodeToSessionId.delete(session.joinCode);
    }

    this._sessions.delete(sessionId);

    this._log.info({ sessionId }, 'Session cleaned up');
  }

  /**
   * Get all active sessions (for debugging/monitoring)
   */
  getActiveSessions(): Session[] {
    const activeSessions: Session[] = [];

    for (const session of this._sessions.values()) {
      if (!this._isSessionExpired(session)) {
        activeSessions.push(session);
      } else {
        this._cleanupSession(session.sessionId);
      }
    }

    return activeSessions;
  }
}
