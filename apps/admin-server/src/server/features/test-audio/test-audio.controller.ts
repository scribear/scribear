import type {
  BaseFastifyReply,
  BaseFastifyRequest,
} from '@scribear/base-fastify-server';

import type { AppDependencies } from '#src/server/dependency-injection/app-dependencies.js';
import {
  errorEnvelope,
  okEnvelope,
} from '#src/server/shared/envelope/envelope.js';
import { auditedMutation } from '#src/server/shared/proxy/audited-proxy.js';

import type {
  START_DEVICE_INPUT,
  STOP_DEVICE_INPUT,
  TestAudioDeviceState,
  UPDATE_PARAMS_INPUT,
} from './test-audio.schema.js';

export class TestAudioController {
  private _gateway: AppDependencies['testAudioGatewayService'];
  private _auditService: AppDependencies['auditService'];

  constructor(
    testAudioGatewayService: AppDependencies['testAudioGatewayService'],
    auditService: AppDependencies['auditService'],
  ) {
    this._gateway = testAudioGatewayService;
    this._auditService = auditService;
  }

  // ---- Reads ----

  /**
   * Both devices and their live state.
   *
   * 200 with `available: false` when the feature is unconfigured, NOT a 503:
   * unlike `/fleet` — where an empty answer is indistinguishable from an idle
   * fleet — "there are no test-audio devices" is unambiguous, and a deployment
   * that never provisioned them should see a disabled panel rather than an
   * error the operator has to rule out (PLAN-TestAudioDevices §3).
   */
  async list(req: BaseFastifyRequest, res: BaseFastifyReply) {
    if (!this._gateway.enabled) {
      return res.code(200).send(okEnvelope({ available: false, devices: [] }));
    }

    const result = await this._gateway.listDevices();
    const outcome = this._gateway.classify(result);
    if (!outcome.ok) {
      // A configured generator that fails to answer IS an error — the operator
      // provisioned it, so its silence is a fault and not a disabled panel.
      this._gateway.respond(req, res, result);
      return res;
    }

    // Passed through as it arrived, like every other proxied read: a generator
    // that adds a field surfaces it without an admin-server release.
    const devices =
      (outcome.data as { devices?: TestAudioDeviceState[] } | null)?.devices ??
      [];
    return res.code(200).send(okEnvelope({ available: true, devices }));
  }

  // ---- Mutations (require read-write + CSRF) ----

  async start(
    req: BaseFastifyRequest<typeof START_DEVICE_INPUT>,
    res: BaseFastifyReply,
  ) {
    if (!this._gateway.enabled) return this._unavailable(req, res);

    const { deviceId } = req.params;
    await auditedMutation({
      gateway: this._gateway,
      auditService: this._auditService,
      req,
      reply: res,
      action: 'start-test-audio-device',
      target: deviceId,
      // The knobs are the whole value of the row: this is the record of what
      // was pointed at a room, at what settings, for how long. None of it is
      // sensitive — the service key and device tokens never come near here.
      paramsSummary: {
        durationSec: req.body.durationSec,
        params: req.body.params ?? {},
      },
      call: () => this._gateway.startDevice(deviceId, req.body),
    });
  }

  async stop(
    req: BaseFastifyRequest<typeof STOP_DEVICE_INPUT>,
    res: BaseFastifyReply,
  ) {
    if (!this._gateway.enabled) return this._unavailable(req, res);

    const { deviceId } = req.params;
    await auditedMutation({
      gateway: this._gateway,
      auditService: this._auditService,
      req,
      reply: res,
      action: 'stop-test-audio-device',
      target: deviceId,
      paramsSummary: {},
      call: () => this._gateway.stopDevice(deviceId),
    });
  }

  async updateParams(
    req: BaseFastifyRequest<typeof UPDATE_PARAMS_INPUT>,
    res: BaseFastifyReply,
  ) {
    if (!this._gateway.enabled) return this._unavailable(req, res);

    const { deviceId } = req.params;
    await auditedMutation({
      gateway: this._gateway,
      auditService: this._auditService,
      req,
      reply: res,
      action: 'retune-test-audio-device',
      target: deviceId,
      // Only the knobs the operator actually moved — a retune body is already
      // a partial, so the row reads as the change rather than the whole state.
      paramsSummary: { params: req.body },
      call: () => this._gateway.updateParams(deviceId, req.body),
    });
  }

  /**
   * Every mutation's answer when `TEST_AUDIO_BASE_URL` is unset.
   *
   * No audit row: nothing changed and no upstream was called, the same as a
   * request the CSRF or role guard turned away. The audit log records actions
   * taken, not buttons that were not wired up.
   */
  private _unavailable(req: BaseFastifyRequest, res: BaseFastifyReply) {
    return res
      .code(503)
      .send(
        errorEnvelope(
          'TEST_AUDIO_UNAVAILABLE',
          'Test audio devices are not configured for this deployment (TEST_AUDIO_BASE_URL unset).',
          req.id,
        ),
      );
  }
}
