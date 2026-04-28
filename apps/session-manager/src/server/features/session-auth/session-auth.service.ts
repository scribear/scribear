import crypto from 'node:crypto';

import type { AuthMethod, SessionScope } from '@scribear/scribear-db';

import type { AppDependencies } from '#src/server/dependency-injection/app-dependencies.js';
import { generateRandomCode } from '#src/server/utils/generate-random-code.js';

import type { JoinCode, SessionAuthRow } from './session-auth.repository.js';

const JOIN_CODE_LENGTH = 8;
const JOIN_CODE_DURATION_MS = 5 * 60 * 1000;
/**
 * Window before the current code expires during which we precompute the next
 * code so the source device can display the upcoming code for handoff. The
 * client polls during this window to pick up the new code.
 */
const JOIN_CODE_HANDOFF_MS = 60 * 1000;

const SESSION_TOKEN_LIFETIME_MS = 5 * 60 * 1000;
const REFRESH_TOKEN_SECRET_BYTES = 32;
const REFRESH_TOKEN_SEPARATOR = ':';

/** Result envelope returned to clients on the two short-lived-token paths. */
interface IssuedSessionToken {
  sessionToken: string;
  sessionTokenExpiresAt: Date;
  scopes: SessionScope[];
}

/** Per-call result of `fetchJoinCodes`, before the controller serializes dates. */
interface FetchJoinCodesResult {
  current: JoinCode;
  next: JoinCode | null;
}

export class SessionAuthService {
  private _log: AppDependencies['logger'];
  private _repo: AppDependencies['sessionAuthRepository'];
  private _hashService: AppDependencies['hashService'];
  private _sessionTokenService: AppDependencies['sessionTokenService'];

  constructor(
    logger: AppDependencies['logger'],
    sessionAuthRepository: AppDependencies['sessionAuthRepository'],
    hashService: AppDependencies['hashService'],
    sessionTokenService: AppDependencies['sessionTokenService'],
  ) {
    this._log = logger;
    this._repo = sessionAuthRepository;
    this._hashService = hashService;
    this._sessionTokenService = sessionTokenService;
  }

  /**
   * Returns the current join code (and the next code, when within the handoff
   * window) for a session. Generates fresh codes on demand so the first call
   * for a session creates the initial code; subsequent calls within a code's
   * lifetime are idempotent.
   *
   * @param deviceUid The authenticated device requesting the codes.
   * @param sessionUid The session to fetch codes for.
   * @param now Reference instant for expiry / handoff calculations.
   */
  async fetchJoinCodes(
    deviceUid: string,
    sessionUid: string,
    now: Date,
  ): Promise<
    | FetchJoinCodesResult
    | 'SESSION_NOT_FOUND'
    | 'DEVICE_NOT_IN_SESSION_ROOM'
    | 'JOIN_CODE_SCOPES_EMPTY'
  > {
    return this._repo.db.transaction().execute(async (trx) => {
      const session = await this._repo.findSessionForAuth(trx, sessionUid);
      if (!session) return 'SESSION_NOT_FOUND' as const;

      const inRoom = await this._repo.isDeviceInRoom(
        trx,
        deviceUid,
        session.roomUid,
      );
      if (!inRoom) return 'DEVICE_NOT_IN_SESSION_ROOM' as const;

      if (session.joinCodeScopes.length === 0) {
        return 'JOIN_CODE_SCOPES_EMPTY' as const;
      }

      const codes = await this._repo.findActiveJoinCodes(trx, sessionUid, now);
      // Codes are ordered by valid_start ASC. The "current" code is the one
      // covering `now`; the "next" code is one whose valid_start > now.
      const currentRow = codes.find(
        (c) =>
          c.validStart.getTime() <= now.getTime() &&
          c.validEnd.getTime() > now.getTime(),
      );
      const nextRow = codes.find((c) => c.validStart.getTime() > now.getTime());

      const current =
        currentRow ??
        (await this._repo.insertJoinCode(trx, {
          joinCode: this._generateJoinCode(),
          sessionUid,
          validStart: now,
          validEnd: new Date(now.getTime() + JOIN_CODE_DURATION_MS),
        }));

      // Precompute the next code only when we're inside the handoff window
      // so source devices can flip the displayed code before the current one
      // expires. Outside the window we leave `next` null to avoid hoarding
      // codes the client can't yet use.
      const msUntilCurrentExpires = current.validEnd.getTime() - now.getTime();
      let next: JoinCode | null = nextRow ?? null;
      if (next === null && msUntilCurrentExpires <= JOIN_CODE_HANDOFF_MS) {
        next = await this._repo.insertJoinCode(trx, {
          joinCode: this._generateJoinCode(),
          sessionUid,
          validStart: current.validEnd,
          validEnd: new Date(
            current.validEnd.getTime() + JOIN_CODE_DURATION_MS,
          ),
        });
      }

      return { current, next };
    });
  }

  /**
   * Mints a short-lived session token for a device that already authenticates
   * via a long-lived `DEVICE_TOKEN` cookie. No refresh token is issued: the
   * device re-calls this endpoint with its cookie when the session token
   * expires.
   *
   * @param deviceUid The authenticated device.
   * @param sessionUid The session to scope the issued token to.
   * @param now Reference instant for the active-session check and token expiry.
   */
  async exchangeDeviceToken(
    deviceUid: string,
    sessionUid: string,
    now: Date,
  ): Promise<
    | IssuedSessionToken
    | 'SESSION_NOT_FOUND'
    | 'DEVICE_NOT_IN_SESSION_ROOM'
    | 'SESSION_NOT_CURRENTLY_ACTIVE'
  > {
    const session = await this._repo.findSessionForAuth(
      this._repo.db,
      sessionUid,
    );
    if (!session) return 'SESSION_NOT_FOUND' as const;

    const inRoom = await this._repo.isDeviceInRoom(
      this._repo.db,
      deviceUid,
      session.roomUid,
    );
    if (!inRoom) return 'DEVICE_NOT_IN_SESSION_ROOM' as const;

    if (!isSessionCurrentlyActive(session, now)) {
      return 'SESSION_NOT_CURRENTLY_ACTIVE' as const;
    }

    const isSource = await this._repo.isDeviceSourceForRoom(
      this._repo.db,
      deviceUid,
      session.roomUid,
    );
    const scopes: SessionScope[] = isSource
      ? ['SEND_AUDIO', 'RECEIVE_TRANSCRIPTIONS']
      : ['RECEIVE_TRANSCRIPTIONS'];

    // Use the device UID as the clientId so re-exchanges from the same device
    // are stable; downstream services that key off clientId can attribute
    // multiple short-lived tokens to the same device session.
    return this._issueSessionTokenSync(session.uid, deviceUid, scopes, now);
  }

  /**
   * Exchanges an unauthenticated join code for a fresh client identity:
   * sessionToken (short-lived) + sessionRefreshToken (persisted) + clientId.
   * Scopes are taken verbatim from the session's `joinCodeScopes`.
   *
   * @param joinCode The join code presented by the client.
   * @param now Reference instant for expiry / active-session checks.
   */
  async exchangeJoinCode(
    joinCode: string,
    now: Date,
  ): Promise<
    | {
        sessionUid: string;
        clientId: string;
        sessionToken: string;
        sessionTokenExpiresAt: Date;
        sessionRefreshToken: string;
        scopes: SessionScope[];
      }
    | 'JOIN_CODE_NOT_FOUND'
    | 'JOIN_CODE_EXPIRED'
    | 'SESSION_NOT_CURRENTLY_ACTIVE'
  > {
    const codeRow = await this._repo.findJoinCodeByCode(
      this._repo.db,
      joinCode,
    );
    if (!codeRow) return 'JOIN_CODE_NOT_FOUND' as const;
    if (codeRow.validEnd.getTime() <= now.getTime()) {
      return 'JOIN_CODE_EXPIRED' as const;
    }

    const session = await this._repo.findSessionForAuth(
      this._repo.db,
      codeRow.sessionUid,
    );
    // The join code FK cascades on session delete, so a missing session here
    // would only happen during a race; treat it as "not active" rather than
    // surfacing an unrelated 404.
    if (!session || !isSessionCurrentlyActive(session, now)) {
      return 'SESSION_NOT_CURRENTLY_ACTIVE' as const;
    }

    const clientId = crypto.randomUUID();
    const scopes = session.joinCodeScopes;
    const issued = await this._issueSessionTokenWithRefresh(
      session.uid,
      clientId,
      scopes,
      'JOIN_CODE',
      now,
    );

    return {
      sessionUid: session.uid,
      clientId,
      sessionToken: issued.sessionToken,
      sessionTokenExpiresAt: issued.sessionTokenExpiresAt,
      sessionRefreshToken: issued.sessionRefreshToken,
      scopes,
    };
  }

  /**
   * Mints a fresh short-lived session token in exchange for a previously
   * issued refresh token. The refresh token itself remains valid until the
   * session ends; we never rotate it because the underlying session lifetime
   * is bounded.
   *
   * @param refreshToken The opaque `{uid}:{secret}` refresh token.
   * @param now Reference instant for the session-ended check and token expiry.
   */
  async refreshSessionToken(
    refreshToken: string,
    now: Date,
  ): Promise<
    | { sessionToken: string; sessionTokenExpiresAt: Date }
    | 'INVALID_REFRESH_TOKEN'
    | 'SESSION_ENDED'
  > {
    const decoded = decodeRefreshToken(refreshToken);
    if (!decoded) {
      this._log.info('Refresh token missing separator');
      return 'INVALID_REFRESH_TOKEN' as const;
    }

    const tokenRow = await this._repo.findRefreshTokenByUid(
      this._repo.db,
      decoded.uid,
    );
    if (!tokenRow) {
      this._log.info('Refresh token not found');
      return 'INVALID_REFRESH_TOKEN' as const;
    }

    const isValid = await this._hashService.verify(
      decoded.secret,
      tokenRow.hash,
    );
    if (!isValid) {
      this._log.info({ uid: decoded.uid }, 'Refresh token secret mismatch');
      return 'INVALID_REFRESH_TOKEN' as const;
    }

    const session = await this._repo.findSessionForAuth(
      this._repo.db,
      tokenRow.sessionUid,
    );
    if (!session || isSessionEnded(session, now)) {
      return 'SESSION_ENDED' as const;
    }

    const issued = this._issueSessionTokenSync(
      tokenRow.sessionUid,
      tokenRow.clientId,
      tokenRow.scopes,
      now,
    );
    return {
      sessionToken: issued.sessionToken,
      sessionTokenExpiresAt: issued.sessionTokenExpiresAt,
    };
  }

  /**
   * Creates a refresh token (random secret, hashed for storage) plus a
   * matching session token. The plaintext refresh token is returned only
   * here; the DB only ever sees the hash.
   */
  private async _issueSessionTokenWithRefresh(
    sessionUid: string,
    clientId: string,
    scopes: SessionScope[],
    authMethod: AuthMethod,
    now: Date,
  ): Promise<IssuedSessionToken & { sessionRefreshToken: string }> {
    const secret = crypto
      .randomBytes(REFRESH_TOKEN_SECRET_BYTES)
      .toString('base64url');
    const hash = await this._hashService.hash(secret);

    const inserted = await this._repo.insertRefreshToken(this._repo.db, {
      sessionUid,
      clientId,
      hash,
      scopes,
      authMethod,
    });

    const sessionRefreshToken = `${inserted.uid}${REFRESH_TOKEN_SEPARATOR}${secret}`;
    const tokenInfo = this._issueSessionTokenSync(
      sessionUid,
      clientId,
      scopes,
      now,
    );

    return {
      sessionToken: tokenInfo.sessionToken,
      sessionTokenExpiresAt: tokenInfo.sessionTokenExpiresAt,
      scopes,
      sessionRefreshToken,
    };
  }

  private _issueSessionTokenSync(
    sessionUid: string,
    clientId: string,
    scopes: SessionScope[],
    now: Date,
  ): IssuedSessionToken {
    const expiresAt = new Date(now.getTime() + SESSION_TOKEN_LIFETIME_MS);
    const sessionToken = this._sessionTokenService.sign({
      sessionUid,
      clientId,
      scopes,
      exp: Math.floor(expiresAt.getTime() / 1000),
    });
    return {
      sessionToken,
      sessionTokenExpiresAt: expiresAt,
      scopes,
    };
  }

  /**
   * Generates a join code matching the format constraint enforced by the
   * `session_join_codes_format` CHECK (`^[A-Z0-9]{8}$`). The shared
   * `generateRandomCode` helper draws from the same alphabet.
   */
  private _generateJoinCode(): string {
    return generateRandomCode(JOIN_CODE_LENGTH);
  }
}

function isSessionCurrentlyActive(session: SessionAuthRow, now: Date): boolean {
  if (session.effectiveStart.getTime() > now.getTime()) return false;
  if (
    session.effectiveEnd !== null &&
    session.effectiveEnd.getTime() <= now.getTime()
  ) {
    return false;
  }
  return true;
}

function isSessionEnded(session: SessionAuthRow, now: Date): boolean {
  return (
    session.effectiveEnd !== null &&
    session.effectiveEnd.getTime() <= now.getTime()
  );
}

function decodeRefreshToken(
  token: string,
): { uid: string; secret: string } | null {
  const idx = token.indexOf(REFRESH_TOKEN_SEPARATOR);
  if (idx === -1) return null;
  return {
    uid: token.slice(0, idx),
    secret: token.slice(idx + 1),
  };
}
