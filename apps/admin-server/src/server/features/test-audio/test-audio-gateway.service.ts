import type { FastifyReply, FastifyRequest } from 'fastify';

import {
  errorEnvelope,
  okEnvelope,
} from '#src/server/shared/envelope/envelope.js';
import type { UpstreamOutcome } from '#src/server/shared/services/session-manager-gateway.service.js';

import type { TestAudioDeviceId, TestAudioParams } from './test-audio.schema.js';

export interface TestAudioConfig {
  /**
   * Origin of `apps/test-audio-generator`. Empty — the default — disables the
   * feature outright; see `enabled`.
   */
  baseUrl: string;
  /** Injected as `Authorization: Bearer`. Never returned, never logged. */
  serviceKey: string;
  /** Hard per-request bound. An operator is waiting on every one of these. */
  timeoutMs: number;
}

/** The generator's control API base path (PLAN-TestAudioDevices §2). */
const TEST_AUDIO_API_PATH = '/api/test-audio/v1';

/**
 * What one upstream call produced. Three outcomes rather than two because
 * "answered with something unreadable" is an operator problem distinct from
 * "did not answer at all", and they map to different statuses.
 */
export type TestAudioResult =
  | { kind: 'response'; status: number; body: unknown }
  | { kind: 'unparseable'; status: number }
  | { kind: 'unreachable'; err: unknown };

/** Body of `POST /devices/:deviceId/start`. */
export interface StartDeviceBody {
  params?: TestAudioParams;
  durationSec: number;
}

/**
 * The ONLY place `TEST_AUDIO_SERVICE_KEY` is used, and the only thing that
 * knows where the generator lives. Shaped like `SessionManagerGatewayService`:
 * controllers depend on this, never on `fetch`, so the key cannot leave the
 * process except through a call declared here. The admin session — cookie,
 * CSRF token, identity — is never forwarded; the upstream authenticates this
 * service, not the operator behind it.
 *
 * Raw `fetch` rather than a generated client, unlike the Session Manager
 * gateway: the generator is an internal service with no client package, four
 * routes, and a hard timeout requirement (`HealthCheckerService` makes the same
 * call for the same reason).
 */
export class TestAudioGatewayService {
  private _baseUrl: string;
  private _serviceKey: string;
  private _timeoutMs: number;

  constructor(testAudioConfig: TestAudioConfig) {
    this._baseUrl = testAudioConfig.baseUrl.replace(/\/+$/, '');
    this._serviceKey = testAudioConfig.serviceKey;
    this._timeoutMs = testAudioConfig.timeoutMs;
  }

  /**
   * False when `TEST_AUDIO_BASE_URL` is unset, which is the default. A
   * deployment that has not provisioned the devices is not broken, so the read
   * answers 200 with `available: false` and mutations 503 — see the controller.
   */
  get enabled(): boolean {
    return this._baseUrl !== '';
  }

  listDevices(): Promise<TestAudioResult> {
    return this._request('GET', '/devices');
  }

  startDevice(
    deviceId: TestAudioDeviceId,
    body: StartDeviceBody,
  ): Promise<TestAudioResult> {
    return this._request('POST', `/devices/${deviceId}/start`, body);
  }

  stopDevice(deviceId: TestAudioDeviceId): Promise<TestAudioResult> {
    return this._request('POST', `/devices/${deviceId}/stop`);
  }

  /**
   * Retunes a *running* device without restarting the stream (PLAN §2) — the
   * whole point of the feature is turning a knob and watching a meter move.
   */
  updateParams(
    deviceId: TestAudioDeviceId,
    body: TestAudioParams,
  ): Promise<TestAudioResult> {
    return this._request('PATCH', `/devices/${deviceId}/params`, body);
  }

  private async _request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<TestAudioResult> {
    const hasBody = body !== undefined;
    let response: Response;
    try {
      response = await fetch(`${this._baseUrl}${TEST_AUDIO_API_PATH}${path}`, {
        method,
        headers: {
          // Injected server-side. The browser never sees this value and never
          // supplies one.
          authorization: `Bearer ${this._serviceKey}`,
          ...(hasBody ? { 'content-type': 'application/json' } : {}),
        },
        ...(hasBody ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(this._timeoutMs),
      });
    } catch (err) {
      return { kind: 'unreachable', err };
    }

    if (response.status === 204) {
      return { kind: 'response', status: 204, body: null };
    }

    try {
      return {
        kind: 'response',
        status: response.status,
        body: (await response.json()) as unknown,
      };
    } catch {
      return { kind: 'unparseable', status: response.status };
    }
  }

  /**
   * Single source of truth for mapping one upstream call to a BFF status +
   * envelope, so `respond` and the audit record can never disagree. Mirrors
   * `SessionManagerGatewayService.classify`, including its two load-bearing
   * decisions:
   *
   * - Upstream 401/403 means the generator rejected OUR service key. That is an
   *   operator error, not an end-user auth failure, so it becomes 502
   *   `BACKEND_MISCONFIGURATION` — a 401 here would bounce the admin to the
   *   login page over a `.env` mistake.
   * - Upstream 4xx otherwise passes through at its own status carrying the
   *   generator's own `code`/`message` (`DEVICE_NOT_CONFIGURED`, a 409 for
   *   starting an already-running device, a 422 over the duration cap).
   */
  classify(result: TestAudioResult): UpstreamOutcome {
    if (result.kind === 'unreachable') {
      return {
        httpStatus: 503,
        ok: false,
        code: 'TEST_AUDIO_UNREACHABLE',
        message: 'The test audio generator is currently unreachable.',
      };
    }

    if (result.kind === 'unparseable') {
      return {
        httpStatus: 502,
        ok: false,
        code: 'UPSTREAM_ERROR',
        message: 'The test audio generator returned an unreadable response.',
      };
    }

    const { status, body } = result;

    if (status === 401 || status === 403) {
      return {
        httpStatus: 502,
        ok: false,
        code: 'BACKEND_MISCONFIGURATION',
        message:
          'The test audio generator rejected our credentials. An operator must verify TEST_AUDIO_SERVICE_KEY matches the generator.',
      };
    }

    if (status >= 200 && status < 300) {
      return { httpStatus: status, ok: true, data: body ?? null };
    }

    if (status >= 500) {
      return {
        httpStatus: 502,
        ok: false,
        code: 'UPSTREAM_ERROR',
        message: 'The test audio generator failed to handle the request.',
      };
    }

    const data = (body ?? {}) as {
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

  /**
   * Classify, log the operator-visible failures, send the envelope, and return
   * the status used so callers can audit the outcome without re-deriving it.
   */
  respond(
    req: FastifyRequest,
    reply: FastifyReply,
    result: TestAudioResult,
  ): number {
    const outcome = this.classify(result);

    if (outcome.code === 'BACKEND_MISCONFIGURATION') {
      req.log.error(
        { upstreamStatus: result.kind === 'response' ? result.status : null },
        'The test audio generator rejected the service key (backend misconfiguration).',
      );
    } else if (outcome.code === 'TEST_AUDIO_UNREACHABLE') {
      req.log.error(
        { err: result.kind === 'unreachable' ? result.err : null },
        'The test audio generator is unreachable.',
      );
    } else if (outcome.code === 'UPSTREAM_ERROR') {
      req.log.error(
        { upstreamStatus: result.kind === 'response' ? result.status : null },
        'Unexpected response from the test audio generator.',
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
