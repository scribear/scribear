import type {
  AutoSessionWindow,
  Device,
  Room,
  Session,
  SessionSchedule,
} from '@scribear/session-manager-schema';

import { ApiError } from './api-error';

export type ScheduleFrequency = 'ONCE' | 'WEEKLY' | 'BIWEEKLY';
export type DayOfWeek = 'SUN' | 'MON' | 'TUE' | 'WED' | 'THU' | 'FRI' | 'SAT';
export type SessionScope = 'SEND_AUDIO' | 'RECEIVE_TRANSCRIPTIONS';

export interface AuditRow {
  id: string;
  actorSubject: string;
  actorProvider: string;
  action: string;
  target: string | null;
  paramsSummary: unknown;
  result: string;
  statusCode: number | null;
  requestId: string | null;
  createdAt: string;
}

export interface TimeRangeQuery {
  roomUid: string;
  from?: string;
  to?: string;
}

export interface CreateScheduleBody {
  roomUid: string;
  name: string;
  activeStart: string;
  activeEnd: string | null;
  localStartTime: string;
  localEndTime: string;
  frequency: ScheduleFrequency;
  daysOfWeek: DayOfWeek[] | null;
  joinCodeScopes: SessionScope[];
  transcriptionProviderId: string;
  transcriptionStreamConfig: unknown;
}

export type UpdateScheduleBody = { scheduleUid: string } & Partial<
  Omit<CreateScheduleBody, 'roomUid'>
>;

export interface CreateAutoWindowBody {
  roomUid: string;
  localStartTime: string;
  localEndTime: string;
  daysOfWeek: DayOfWeek[];
  activeStart: string;
  activeEnd: string | null;
  joinCodeScopes: SessionScope[];
  transcriptionProviderId: string;
  transcriptionStreamConfig: unknown;
}

export type UpdateAutoWindowBody = { windowUid: string } & Partial<
  Omit<CreateAutoWindowBody, 'roomUid'>
>;

export interface CreateOnDemandSessionBody {
  roomUid: string;
  name: string;
  joinCodeScopes: SessionScope[];
  transcriptionProviderId: string;
  transcriptionStreamConfig: unknown;
}

export interface SessionsRangeQuery {
  roomUids?: string[];
  from: string; // ISO
  to: string; // ISO
}

const BASE = '/api/admin/v1';

/** `EventSource` can't go through `_request` (it sends no cookie header the
 *  way `fetch` does — it relies on `withCredentials` instead), so the fleet
 *  stream hook needs the raw URL. */
export const FLEET_STREAM_URL = `${BASE}/fleet/stream`;

export interface AuthConfig {
  local: boolean;
  sso: boolean;
}

export interface Identity {
  subject: string;
  displayName: string;
  provider: 'local' | 'sso';
  roles: string[];
}

export interface SessionInfo {
  identity: Identity;
  csrfToken: string;
}

/** One dependency in the BFF health rollup. */
export interface HealthComponent {
  /** Stable identifier, matching the compose service name where there is one. */
  name: string;
  /** 'ok' | 'degraded' | 'unreachable' | 'fail'; kept loose so a new status
   *  added server-side renders rather than breaking the build. */
  status: string;
  latencyMs: number;
  /** One-line cause when the component is not ok. */
  detail?: string;
}

export interface HealthReport {
  bff: string;
  /** Every checked dependency. A list rather than named fields so the
   *  dashboard renders new components (B1.7 providers, and so on) without a
   *  matching SPA change. */
  components: HealthComponent[];
  checkedAt: string;
}

export interface Paginated<T> {
  items: T[];
  nextCursor: string | null;
}

// ---- Fleet telemetry (B1.7 §2.5) ----
// Mirrors `FleetSnapshot` in
// apps/admin-server/src/server/shared/services/fleet-telemetry.service.ts and
// the node-server / transcription-service snapshot schemas it composes, from
// @scribear/scribear-redis. Restated here rather than imported: that package
// depends on ioredis and has no browser-safe entry point, so importing it
// would pull a Node Redis client into this bundle. Kept in step by eye, the
// same way transcription-service's Python side restates the TypeScript
// contract (webserver/features/telemetry/telemetry_keys.py).

export interface LatencySeries {
  measure: 'pipeline' | 'e2e';
  kind: 'final' | 'inProgress';
  count: number;
  sum: number;
  sampleCount: number;
  min: number;
  max: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
}

export type UpstreamState =
  | 'IDLE'
  | 'CONNECTING'
  | 'HANDSHAKING'
  | 'OPEN'
  | 'WAITING_RETRY'
  | 'CLOSED';

/** One live session, as published by the owning node-server instance. */
export interface SessionSnapshot {
  sessionUid: string;
  providerKey: string;
  sourceCount: number;
  subscriberCount: number;
  pendingChunkCount: number;
  upstreamState: UpstreamState;
  upstreamRetryAttempt: number;
  latency: LatencySeries[];
  /** Publish time, epoch ms, on the publishing host's clock. */
  updatedAt: number;
  nodeInstanceId: string;
  processUid: string;
}

/** One node-server instance's own counters, excluding its session list. */
export interface NodeSnapshot {
  processUid: string;
  processStartedAt: string;
  generatedAt: string;
  summary: {
    activeSessionCount: number;
    decodeDropsTotal: number;
    pendingChunkEvictionsTotal: number;
    upstreamChurnTotal: number;
    authSuccessTotal: number;
    authTimeoutsTotal: number;
    orchestratorFailuresTotal: number;
    latencySamplesTotal: number;
    latencyE2eUnavailableTotal: number;
    latencyE2eNegativeTotal: number;
    latencyUnmatchedChunkTotal: number;
  };
  upstreamStateTransitions: {
    from: UpstreamState;
    to: UpstreamState;
    count: number;
  }[];
  wsCloses: {
    code: number;
    reason: string;
    role: 'source' | 'client';
    initiator: 'server' | 'peer';
    count: number;
  }[];
  latency: LatencySeries[];
  authFailures: { reason: string; count: number }[];
  updatedAt: number;
  nodeInstanceId: string;
}

export interface TranscriptionWorker {
  workerId: number;
  utilization: number;
  liveJobCount: number;
  totalJobsRegistered: number;
  contextIds: string[];
  alive: boolean;
}

/** Fields that don't apply to a provider's `kind` are `null`, never omitted. */
export interface ProviderHealth {
  providerUid: string;
  kind: 'local' | 'remote' | 'debug' | 'unknown';
  status: 'ok' | 'degraded' | 'down';
  activeSessions: number;
  model: string | null;
  modelLoaded: boolean | null;
  owningWorkers: TranscriptionWorker[];
  endpoint: string | null;
  reachable: boolean | null;
  probeLatencyMs: number | null;
  detail: string | null;
}

/** One Transcription Service host's entire `/providers/health` body, plus envelope. */
export interface TranscriptionHostSnapshot {
  updatedAt: number;
  transcriptionHost: string;
  processUid: string;
  processStartedAt: string;
  numWorkers: number;
  invalidProviderKeyRejects: number;
  workers: TranscriptionWorker[];
  /** Keyed by configured provider key, verbatim. */
  providers: Record<string, ProviderHealth>;
}

/**
 * One provider merged across every Transcription Service host serving it.
 * `status` is `down` only when every host reporting this key is `down`, `ok`
 * only when every host is `ok`; `activeSessions` is summed.
 */
export interface MergedProvider {
  providerKey: string;
  status: 'ok' | 'degraded' | 'down';
  activeSessions: number;
  hosts: { transcriptionHost: string; health: ProviderHealth }[];
}

export interface FleetSnapshot {
  generatedAt: number;
  nodes: NodeSnapshot[];
  sessions: SessionSnapshot[];
  transcriptionHosts: TranscriptionHostSnapshot[];
  providers: MergedProvider[];
}

/**
 * Sub-second delta pushed over `/fleet/stream` — a plain SSE `message` event
 * (no `event:` name to switch on; the `t` field is the discriminant). Only
 * the `session` variant has a writer today; an unrecognized `t` should be
 * ignored rather than treated as an error, so this stays forward-compatible
 * with a `node`/`provider` variant added later.
 */
export interface SessionStatusEvent {
  t: 'session';
  sessionUid: string;
  transcriptionServiceConnected: boolean;
  sourceDeviceConnected: boolean;
  /** Publish time, epoch ms, on the publisher's clock. */
  at: number;
}
export type FleetEvent = SessionStatusEvent;

export interface RoomDetail {
  room: Room;
  devices: Device[];
}

export interface RegisterDeviceResult {
  deviceUid: string;
  activationCode: string;
  expiry: string;
}

export interface ReregisterDeviceResult {
  activationCode: string;
  expiry: string;
}

export interface ListRoomsQuery {
  search?: string;
  cursor?: string;
  limit?: number;
}

export interface ListDevicesQuery {
  search?: string;
  active?: boolean;
  roomUid?: string;
  cursor?: string;
  limit?: number;
}

interface EnvelopeOk<T> {
  ok: true;
  data: T;
}
interface EnvelopeErr {
  ok: false;
  error: { code: string; message: string; requestId?: string };
}

type QueryValue = string | number | boolean | null | undefined | string[];

function toQueryString(params: Record<string, QueryValue>): string {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) {
      for (const item of v) usp.append(k, item);
    } else {
      usp.set(k, String(v));
    }
  }
  const s = usp.toString();
  return s ? `?${s}` : '';
}

/**
 * Typed client for the admin BFF. It:
 * - always sends the session cookie (`credentials: 'include'`),
 * - attaches the CSRF token header on state-changing requests,
 * - unwraps the `{ ok, data }` envelope, throwing {@link ApiError} otherwise,
 * - invokes `onUnauthorized` on a 401 so the app can route to /login.
 *
 * The admin API key is NEVER present here — it lives only in the BFF.
 */
export class AdminApiClient {
  private _csrfToken = '';
  private _onUnauthorized: (() => void) | undefined;

  setCsrfToken(token: string): void {
    this._csrfToken = token;
  }

  setOnUnauthorized(cb: () => void): void {
    this._onUnauthorized = cb;
  }

  private async _request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const isMutation = method !== 'GET';
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (isMutation) headers['x-csrf-token'] = this._csrfToken;

    let res: Response;
    try {
      res = await fetch(`${BASE}${path}`, {
        method,
        credentials: 'include',
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw new ApiError('NETWORK', 'Could not reach the admin server.', 0);
    }

    let json: EnvelopeOk<T> | EnvelopeErr | undefined;
    try {
      json = (await res.json()) as EnvelopeOk<T> | EnvelopeErr;
    } catch {
      json = undefined;
    }

    if (res.ok && json?.ok) {
      return json.data;
    }

    if (res.status === 401) {
      // Session expired / not authenticated. Let the app react (route to login).
      this._onUnauthorized?.();
    }

    const err =
      json && !json.ok
        ? json.error
        : { code: 'UNKNOWN', message: 'The request failed.' };
    throw new ApiError(err.code, err.message, res.status, err.requestId);
  }

  // ---- Auth ----
  getAuthConfig(): Promise<AuthConfig> {
    return this._request('GET', '/auth/config');
  }
  me(): Promise<SessionInfo> {
    return this._request('GET', '/auth/me');
  }
  login(username: string, password: string): Promise<SessionInfo> {
    return this._request('POST', '/auth/login', { username, password });
  }
  logout(): Promise<null> {
    return this._request('POST', '/auth/logout');
  }

  // ---- Health ----
  health(): Promise<HealthReport> {
    return this._request('GET', '/health');
  }

  // ---- Fleet telemetry ----
  /** Throws `ApiError` with code `TELEMETRY_UNAVAILABLE` (REDIS_URL unset) or
   *  `TELEMETRY_DEGRADED` (a read failed) — never resolves to an empty
   *  snapshot for either case, since that would be indistinguishable from a
   *  fleet that is genuinely idle. */
  fleet(): Promise<FleetSnapshot> {
    return this._request('GET', '/fleet');
  }

  // ---- Rooms ----
  listRooms(query: ListRoomsQuery = {}): Promise<Paginated<Room>> {
    return this._request(
      'GET',
      `/rooms/list${toQueryString(query as Record<string, QueryValue>)}`,
    );
  }
  getRoom(roomUid: string): Promise<Room> {
    return this._request('GET', `/rooms/get/${encodeURIComponent(roomUid)}`);
  }
  roomDetail(roomUid: string): Promise<RoomDetail> {
    return this._request('GET', `/rooms/detail/${encodeURIComponent(roomUid)}`);
  }
  createRoom(body: {
    name: string;
    timezone: string;
    autoSessionEnabled: boolean;
    sourceDeviceUids: string[];
  }): Promise<Room> {
    return this._request('POST', '/rooms/create', body);
  }
  updateRoom(body: { roomUid: string; name?: string }): Promise<Room> {
    return this._request('POST', '/rooms/update', body);
  }
  deleteRoom(roomUid: string): Promise<null> {
    return this._request('POST', '/rooms/delete', { roomUid });
  }
  addDeviceToRoom(body: {
    roomUid: string;
    deviceUid: string;
    asSource: boolean;
  }): Promise<null> {
    return this._request('POST', '/rooms/add-device', body);
  }
  removeDeviceFromRoom(deviceUid: string): Promise<null> {
    return this._request('POST', '/rooms/remove-device', { deviceUid });
  }
  setSourceDevice(body: { roomUid: string; deviceUid: string }): Promise<null> {
    return this._request('POST', '/rooms/set-source', body);
  }

  // ---- Devices ----
  listDevices(query: ListDevicesQuery = {}): Promise<Paginated<Device>> {
    return this._request(
      'GET',
      `/devices/list${toQueryString(query as Record<string, QueryValue>)}`,
    );
  }
  getDevice(deviceUid: string): Promise<Device> {
    return this._request(
      'GET',
      `/devices/get/${encodeURIComponent(deviceUid)}`,
    );
  }
  registerDevice(name: string): Promise<RegisterDeviceResult> {
    return this._request('POST', '/devices/register', { name });
  }
  reregisterDevice(deviceUid: string): Promise<ReregisterDeviceResult> {
    return this._request('POST', '/devices/reregister', { deviceUid });
  }
  updateDevice(body: { deviceUid: string; name?: string }): Promise<Device> {
    return this._request('POST', '/devices/update', body);
  }
  deleteDevice(deviceUid: string): Promise<null> {
    return this._request('POST', '/devices/delete', { deviceUid });
  }

  // ---- Schedules ----
  listSchedules(query: TimeRangeQuery): Promise<{ items: SessionSchedule[] }> {
    return this._request(
      'GET',
      `/schedules/list${toQueryString(query as unknown as Record<string, QueryValue>)}`,
    );
  }
  getSchedule(scheduleUid: string): Promise<SessionSchedule> {
    return this._request(
      'GET',
      `/schedules/get/${encodeURIComponent(scheduleUid)}`,
    );
  }
  createSchedule(body: CreateScheduleBody): Promise<SessionSchedule> {
    return this._request('POST', '/schedules/create', body);
  }
  updateSchedule(body: UpdateScheduleBody): Promise<SessionSchedule> {
    return this._request('POST', '/schedules/update', body);
  }
  deleteSchedule(scheduleUid: string): Promise<null> {
    return this._request('POST', '/schedules/delete', { scheduleUid });
  }

  // ---- Auto-session windows ----
  listAutoWindows(
    query: TimeRangeQuery,
  ): Promise<{ items: AutoSessionWindow[] }> {
    return this._request(
      'GET',
      `/auto-windows/list${toQueryString(query as unknown as Record<string, QueryValue>)}`,
    );
  }
  getAutoWindow(windowUid: string): Promise<AutoSessionWindow> {
    return this._request(
      'GET',
      `/auto-windows/get/${encodeURIComponent(windowUid)}`,
    );
  }
  createAutoWindow(body: CreateAutoWindowBody): Promise<AutoSessionWindow> {
    return this._request('POST', '/auto-windows/create', body);
  }
  updateAutoWindow(body: UpdateAutoWindowBody): Promise<AutoSessionWindow> {
    return this._request('POST', '/auto-windows/update', body);
  }
  deleteAutoWindow(windowUid: string): Promise<null> {
    return this._request('POST', '/auto-windows/delete', { windowUid });
  }

  // ---- Room schedule config (auto-session master switch) ----
  updateRoomScheduleConfig(body: {
    roomUid: string;
    autoSessionEnabled?: boolean;
  }): Promise<Room> {
    return this._request('POST', '/schedules/room-config', body);
  }

  // ---- Sessions ----
  getSession(sessionUid: string): Promise<Session> {
    return this._request(
      'GET',
      `/sessions/get/${encodeURIComponent(sessionUid)}`,
    );
  }
  listSessions(query: SessionsRangeQuery): Promise<{ items: Session[] }> {
    return this._request(
      'GET',
      `/sessions/list${toQueryString(query as unknown as Record<string, QueryValue>)}`,
    );
  }
  createOnDemandSession(body: CreateOnDemandSessionBody): Promise<Session> {
    return this._request('POST', '/sessions/create-on-demand', body);
  }
  startSessionEarly(sessionUid: string): Promise<null> {
    return this._request('POST', '/sessions/start-early', { sessionUid });
  }
  endSessionEarly(sessionUid: string): Promise<null> {
    return this._request('POST', '/sessions/end-early', { sessionUid });
  }
  cancelSession(sessionUid: string): Promise<null> {
    return this._request('POST', '/sessions/cancel', { sessionUid });
  }
  uncancelSession(sessionUid: string): Promise<null> {
    return this._request('POST', '/sessions/uncancel', { sessionUid });
  }

  // ---- Audit ----
  listAudit(limit = 50): Promise<{ items: AuditRow[] }> {
    return this._request('GET', `/audit${toQueryString({ limit })}`);
  }
}

/** Shared singleton client. */
export const adminApi = new AdminApiClient();
