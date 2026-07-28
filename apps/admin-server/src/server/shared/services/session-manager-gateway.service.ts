import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Static } from 'typebox';

import { NetworkError } from '@scribear/base-api-client';
import type { EndpointError } from '@scribear/base-api-client';
import { createSessionManagerClient as buildClient } from '@scribear/session-manager-client';
import type { SessionManagerClient } from '@scribear/session-manager-client';
import {
  ADD_DEVICE_TO_ROOM_SCHEMA,
  CANCEL_SESSION_SCHEMA,
  CREATE_AUTO_SESSION_WINDOW_SCHEMA,
  CREATE_ON_DEMAND_SESSION_SCHEMA,
  CREATE_ROOM_SCHEMA,
  CREATE_SCHEDULE_SCHEMA,
  DELETE_AUTO_SESSION_WINDOW_SCHEMA,
  DELETE_DEVICE_SCHEMA,
  DELETE_ROOM_SCHEMA,
  DELETE_SCHEDULE_SCHEMA,
  END_SESSION_EARLY_SCHEMA,
  GET_ACTIVE_SESSION_SCHEMA,
  GET_AUTO_SESSION_WINDOW_SCHEMA,
  GET_DEVICE_SCHEMA,
  GET_ROOM_SCHEMA,
  GET_SCHEDULE_SCHEMA,
  GET_SESSION_SCHEMA,
  LIST_AUTO_SESSION_WINDOWS_SCHEMA,
  LIST_DEVICES_SCHEMA,
  LIST_ROOMS_SCHEMA,
  LIST_SCHEDULES_SCHEMA,
  LIST_SESSIONS_SCHEMA,
  REGISTER_DEVICE_SCHEMA,
  REMOVE_DEVICE_FROM_ROOM_SCHEMA,
  REREGISTER_DEVICE_SCHEMA,
  SET_SOURCE_DEVICE_SCHEMA,
  START_SESSION_EARLY_SCHEMA,
  UNCANCEL_SESSION_SCHEMA,
  UPDATE_AUTO_SESSION_WINDOW_SCHEMA,
  UPDATE_DEVICE_SCHEMA,
  UPDATE_ROOM_SCHEDULE_CONFIG_SCHEMA,
  UPDATE_ROOM_SCHEMA,
  UPDATE_SCHEDULE_SCHEMA,
} from '@scribear/session-manager-schema';

import { errorEnvelope, okEnvelope } from '../envelope/envelope.js';

export interface SessionManagerGatewayConfig {
  adminApiKey: string;
  sessionManagerBaseUrl: string;
}

/**
 * Loose shape of any Session Manager client result tuple. The concrete client
 * methods return more specific unions that are all assignable to this.
 */
export type GatewayResult = readonly [
  { status: number; data: unknown } | null,
  EndpointError | null,
];

/**
 * The ONLY place the Session Manager admin API key is used. Controllers depend
 * on this gateway, never on the raw client, so the key cannot be sent upstream
 * without going through an audited wrapper here. The key is never returned to
 * the caller and never logged.
 */
export class SessionManagerGatewayService {
  private _client: SessionManagerClient;
  private _adminApiKey: string;

  constructor(sessionManagerGatewayConfig: SessionManagerGatewayConfig) {
    this._client = buildClient(
      sessionManagerGatewayConfig.sessionManagerBaseUrl.replace(/\/+$/, ''),
    );
    this._adminApiKey = sessionManagerGatewayConfig.adminApiKey;
  }

  private _authHeaders(): { authorization: string } {
    return { authorization: `Bearer ${this._adminApiKey}` };
  }

  // ---- Rooms ----

  listRooms(querystring: Static<(typeof LIST_ROOMS_SCHEMA)['querystring']>) {
    return this._client.roomManagement.listRooms({
      headers: this._authHeaders(),
      querystring,
    });
  }

  getRoom(params: Static<(typeof GET_ROOM_SCHEMA)['params']>) {
    return this._client.roomManagement.getRoom({
      headers: this._authHeaders(),
      params,
    });
  }

  createRoom(body: Static<(typeof CREATE_ROOM_SCHEMA)['body']>) {
    return this._client.roomManagement.createRoom({
      headers: this._authHeaders(),
      body,
    });
  }

  updateRoom(body: Static<(typeof UPDATE_ROOM_SCHEMA)['body']>) {
    return this._client.roomManagement.updateRoom({
      headers: this._authHeaders(),
      body,
    });
  }

  deleteRoom(body: Static<(typeof DELETE_ROOM_SCHEMA)['body']>) {
    return this._client.roomManagement.deleteRoom({
      headers: this._authHeaders(),
      body,
    });
  }

  addDeviceToRoom(body: Static<(typeof ADD_DEVICE_TO_ROOM_SCHEMA)['body']>) {
    return this._client.roomManagement.addDeviceToRoom({
      headers: this._authHeaders(),
      body,
    });
  }

  removeDeviceFromRoom(
    body: Static<(typeof REMOVE_DEVICE_FROM_ROOM_SCHEMA)['body']>,
  ) {
    return this._client.roomManagement.removeDeviceFromRoom({
      headers: this._authHeaders(),
      body,
    });
  }

  setSourceDevice(body: Static<(typeof SET_SOURCE_DEVICE_SCHEMA)['body']>) {
    return this._client.roomManagement.setSourceDevice({
      headers: this._authHeaders(),
      body,
    });
  }

  // ---- Devices ----

  listDevices(
    querystring: Static<(typeof LIST_DEVICES_SCHEMA)['querystring']>,
  ) {
    return this._client.deviceManagement.listDevices({
      headers: this._authHeaders(),
      querystring,
    });
  }

  getDevice(params: Static<(typeof GET_DEVICE_SCHEMA)['params']>) {
    return this._client.deviceManagement.getDevice({
      headers: this._authHeaders(),
      params,
    });
  }

  registerDevice(body: Static<(typeof REGISTER_DEVICE_SCHEMA)['body']>) {
    return this._client.deviceManagement.registerDevice({
      headers: this._authHeaders(),
      body,
    });
  }

  reregisterDevice(body: Static<(typeof REREGISTER_DEVICE_SCHEMA)['body']>) {
    return this._client.deviceManagement.reregisterDevice({
      headers: this._authHeaders(),
      body,
    });
  }

  updateDevice(body: Static<(typeof UPDATE_DEVICE_SCHEMA)['body']>) {
    return this._client.deviceManagement.updateDevice({
      headers: this._authHeaders(),
      body,
    });
  }

  deleteDevice(body: Static<(typeof DELETE_DEVICE_SCHEMA)['body']>) {
    return this._client.deviceManagement.deleteDevice({
      headers: this._authHeaders(),
      body,
    });
  }

  // ---- Scheduling ----

  listSchedules(
    querystring: Static<(typeof LIST_SCHEDULES_SCHEMA)['querystring']>,
  ) {
    return this._client.scheduleManagement.listSchedules({
      headers: this._authHeaders(),
      querystring,
    });
  }

  getSchedule(params: Static<(typeof GET_SCHEDULE_SCHEMA)['params']>) {
    return this._client.scheduleManagement.getSchedule({
      headers: this._authHeaders(),
      params,
    });
  }

  createSchedule(body: Static<(typeof CREATE_SCHEDULE_SCHEMA)['body']>) {
    return this._client.scheduleManagement.createSchedule({
      headers: this._authHeaders(),
      body,
    });
  }

  updateSchedule(body: Static<(typeof UPDATE_SCHEDULE_SCHEMA)['body']>) {
    return this._client.scheduleManagement.updateSchedule({
      headers: this._authHeaders(),
      body,
    });
  }

  deleteSchedule(body: Static<(typeof DELETE_SCHEDULE_SCHEMA)['body']>) {
    return this._client.scheduleManagement.deleteSchedule({
      headers: this._authHeaders(),
      body,
    });
  }

  listAutoSessionWindows(
    querystring: Static<
      (typeof LIST_AUTO_SESSION_WINDOWS_SCHEMA)['querystring']
    >,
  ) {
    return this._client.scheduleManagement.listAutoSessionWindows({
      headers: this._authHeaders(),
      querystring,
    });
  }

  getAutoSessionWindow(
    params: Static<(typeof GET_AUTO_SESSION_WINDOW_SCHEMA)['params']>,
  ) {
    return this._client.scheduleManagement.getAutoSessionWindow({
      headers: this._authHeaders(),
      params,
    });
  }

  createAutoSessionWindow(
    body: Static<(typeof CREATE_AUTO_SESSION_WINDOW_SCHEMA)['body']>,
  ) {
    return this._client.scheduleManagement.createAutoSessionWindow({
      headers: this._authHeaders(),
      body,
    });
  }

  updateAutoSessionWindow(
    body: Static<(typeof UPDATE_AUTO_SESSION_WINDOW_SCHEMA)['body']>,
  ) {
    return this._client.scheduleManagement.updateAutoSessionWindow({
      headers: this._authHeaders(),
      body,
    });
  }

  deleteAutoSessionWindow(
    body: Static<(typeof DELETE_AUTO_SESSION_WINDOW_SCHEMA)['body']>,
  ) {
    return this._client.scheduleManagement.deleteAutoSessionWindow({
      headers: this._authHeaders(),
      body,
    });
  }

  updateRoomScheduleConfig(
    body: Static<(typeof UPDATE_ROOM_SCHEDULE_CONFIG_SCHEMA)['body']>,
  ) {
    return this._client.scheduleManagement.updateRoomScheduleConfig({
      headers: this._authHeaders(),
      body,
    });
  }

  getSession(params: Static<(typeof GET_SESSION_SCHEMA)['params']>) {
    return this._client.scheduleManagement.getSession({
      headers: this._authHeaders(),
      params,
    });
  }

  listSessions(
    querystring: Static<(typeof LIST_SESSIONS_SCHEMA)['querystring']>,
  ) {
    return this._client.scheduleManagement.listSessions({
      headers: this._authHeaders(),
      querystring,
    });
  }

  getActiveSession(
    params: Static<(typeof GET_ACTIVE_SESSION_SCHEMA)['params']>,
  ) {
    return this._client.scheduleManagement.getActiveSession({
      headers: this._authHeaders(),
      params,
    });
  }

  createOnDemandSession(
    body: Static<(typeof CREATE_ON_DEMAND_SESSION_SCHEMA)['body']>,
  ) {
    return this._client.scheduleManagement.createOnDemandSession({
      headers: this._authHeaders(),
      body,
    });
  }

  startSessionEarly(body: Static<(typeof START_SESSION_EARLY_SCHEMA)['body']>) {
    return this._client.scheduleManagement.startSessionEarly({
      headers: this._authHeaders(),
      body,
    });
  }

  endSessionEarly(body: Static<(typeof END_SESSION_EARLY_SCHEMA)['body']>) {
    return this._client.scheduleManagement.endSessionEarly({
      headers: this._authHeaders(),
      body,
    });
  }

  cancelSession(body: Static<(typeof CANCEL_SESSION_SCHEMA)['body']>) {
    return this._client.scheduleManagement.cancelSession({
      headers: this._authHeaders(),
      body,
    });
  }

  uncancelSession(body: Static<(typeof UNCANCEL_SESSION_SCHEMA)['body']>) {
    return this._client.scheduleManagement.uncancelSession({
      headers: this._authHeaders(),
      body,
    });
  }

  // Named as a "get" to read naturally from the BFF's perspective (it mints a
  // code on demand but is idempotent within the code's lifetime, and is
  // registered as a GET route on the admin-server side) even though it
  // forwards as a POST upstream — the gateway already does this kind of shape
  // translation elsewhere (e.g. `startSessionEarly`).
  getSessionJoinCode(params: Static<(typeof GET_SESSION_SCHEMA)['params']>) {
    return this._client.sessionAuth.adminFetchJoinCode({
      headers: this._authHeaders(),
      body: { sessionUid: params.sessionUid },
    });
  }

  // ---- Demo room ----

  getDemoRoomStatus() {
    return this._client.demoRoom.status({ headers: this._authHeaders() });
  }

  // ---- Database schema ----

  /**
   * What schema version the Session Manager container expects, and what the
   * database it is pointed at has applied. Read by the Config Check.
   *
   * Takes a `RequestInit` so the caller can impose a timeout: unlike the routes
   * above, this one is called on a page an operator is already waiting on, and
   * `createEndpointClient` issues a bare `fetch` with no `AbortSignal` of its own.
   */
  getSchemaStatus(init?: RequestInit) {
    return this._client.database.schemaStatus(
      { headers: this._authHeaders() },
      init,
    );
  }

  // ---- Probes (unauthenticated upstream) ----

  readiness() {
    return this._client.probes.readiness({});
  }

  /**
   * Single source of truth for mapping a Session Manager client result
   * `[response, error]` to a BFF HTTP status + envelope shape. Used by both
   * `respond` (to send) and controllers (to audit the outcome).
   *
   * - Upstream 2xx -> ok (204 normalized to 200 with `data: null`).
   * - Upstream declared 4xx (404/409/422/400/403/410) -> passthrough at status.
   * - Upstream 401 -> our admin key was rejected: an OPERATOR error, not an
   *   end-user auth failure. Surfaced as 502 `BACKEND_MISCONFIGURATION` so the
   *   SPA shows a distinct banner and does NOT redirect to login.
   * - Upstream 429 -> 429 `RATE_LIMITED`.
   * - Undeclared status -> 502; network failure -> 503.
   */
  classify(result: GatewayResult): UpstreamOutcome {
    const [response, error] = result;

    if (response) {
      const status = response.status;

      if (status === 401) {
        return {
          httpStatus: 502,
          ok: false,
          code: 'BACKEND_MISCONFIGURATION',
          message:
            'The admin backend rejected our credentials. An operator must verify ADMIN_API_KEY matches Session Manager.',
        };
      }

      if (status >= 200 && status < 300) {
        return {
          httpStatus: status === 204 ? 200 : status,
          ok: true,
          data: response.data ?? null,
        };
      }

      const data = (response.data ?? {}) as {
        code?: string;
        message?: string;
        details?: Record<string, unknown>;
      };
      return {
        httpStatus: status,
        ok: false,
        code: data.code ?? 'UPSTREAM_ERROR',
        message: data.message ?? 'The request could not be completed.',
        ...(data.details ? { details: data.details } : {}),
      };
    }

    if (error && !(error instanceof NetworkError)) {
      if (error.status === 429) {
        return {
          httpStatus: 429,
          ok: false,
          code: 'RATE_LIMITED',
          message:
            'The admin backend is rate limiting requests. Please retry shortly.',
        };
      }
      return {
        httpStatus: 502,
        ok: false,
        code: 'UPSTREAM_ERROR',
        message: 'The admin backend returned an unexpected response.',
      };
    }

    return {
      httpStatus: 503,
      ok: false,
      code: 'UPSTREAM_UNREACHABLE',
      message: 'The admin backend is currently unreachable.',
    };
  }

  /**
   * Classify a client result, log operator-visible failures, send the envelope,
   * and return the HTTP status used (so callers can audit the outcome without
   * re-deriving it).
   */
  respond(
    req: FastifyRequest,
    reply: FastifyReply,
    result: GatewayResult,
  ): number {
    const outcome = this.classify(result);
    const [, error] = result;

    if (outcome.code === 'BACKEND_MISCONFIGURATION') {
      req.log.error(
        { upstreamStatus: 401 },
        'Session Manager rejected the admin API key (backend misconfiguration).',
      );
    } else if (outcome.code === 'UPSTREAM_UNREACHABLE') {
      req.log.error({ err: error }, 'Session Manager is unreachable.');
    } else if (outcome.code === 'UPSTREAM_ERROR' && !result[0]) {
      req.log.error(
        { err: error },
        'Unexpected response from Session Manager.',
      );
    }

    if (outcome.ok) {
      reply.code(outcome.httpStatus).send(okEnvelope(outcome.data ?? null));
    } else {
      reply
        .code(outcome.httpStatus)
        .send(
          errorEnvelope(
            outcome.code ?? 'UPSTREAM_ERROR',
            outcome.message ?? 'The request could not be completed.',
            req.id,
            outcome.details,
          ),
        );
    }

    return outcome.httpStatus;
  }
}

export interface UpstreamOutcome {
  httpStatus: number;
  ok: boolean;
  code?: string;
  message?: string;
  details?: Record<string, unknown>;
  data?: unknown;
}
