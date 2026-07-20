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

const BASE = '/api/admin/v1';

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

type QueryValue = string | number | boolean | null | undefined;

function toQueryString(params: Record<string, QueryValue>): string {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') usp.set(k, String(v));
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
  createOnDemandSession(body: CreateOnDemandSessionBody): Promise<Session> {
    return this._request('POST', '/sessions/create-on-demand', body);
  }
  startSessionEarly(sessionUid: string): Promise<null> {
    return this._request('POST', '/sessions/start-early', { sessionUid });
  }
  endSessionEarly(sessionUid: string): Promise<null> {
    return this._request('POST', '/sessions/end-early', { sessionUid });
  }

  // ---- Audit ----
  listAudit(limit = 50): Promise<{ items: AuditRow[] }> {
    return this._request('GET', `/audit${toQueryString({ limit })}`);
  }
}

/** Shared singleton client. */
export const adminApi = new AdminApiClient();
