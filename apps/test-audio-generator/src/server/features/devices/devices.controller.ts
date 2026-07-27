import type {
  BaseFastifyReply,
  BaseFastifyRequest,
} from '@scribear/base-fastify-server';
import { BaseHttpError } from '@scribear/base-fastify-server';

import type { AppDependencies } from '#src/server/dependency-injection/app-dependencies.js';
import type { DeviceId } from '#src/server/shared/devices/device-state.js';

import {
  FAULT_PARAM_KEYS,
  GOOD_PARAM_KEYS,
  type START_DEVICE_INPUT,
  type STOP_DEVICE_INPUT,
  type UPDATE_PARAMS_INPUT,
} from './devices.schema.js';

/**
 * The control API (PLAN-TestAudioDevices §2).
 *
 * Answers are bare JSON — `{ devices: [...] }` for the read, a `DeviceState`
 * for each mutation — not the admin envelope. That is deliberate and is what
 * `TestAudioGatewayService` expects: it reads the body it gets, wraps successes
 * in `okEnvelope` itself, and reads `code`/`message`/`details` off a 4xx body,
 * which is exactly the shape `base-fastify-server`'s error handler already
 * emits. Two envelopes would mean the BFF unwrapping one to build another.
 */
export class DevicesController {
  private _manager: AppDependencies['deviceRunManagerService'];

  constructor(
    deviceRunManagerService: AppDependencies['deviceRunManagerService'],
  ) {
    this._manager = deviceRunManagerService;
  }

  list(_req: BaseFastifyRequest, res: BaseFastifyReply) {
    return res.code(200).send({ devices: this._manager.list() });
  }

  start(
    req: BaseFastifyRequest<typeof START_DEVICE_INPUT>,
    res: BaseFastifyReply,
  ) {
    const { deviceId } = req.params;
    const params = assertKnownParams(deviceId, req.body.params);
    return res
      .code(200)
      .send(this._manager.start(deviceId, params, req.body.durationSec));
  }

  async stop(
    req: BaseFastifyRequest<typeof STOP_DEVICE_INPUT>,
    res: BaseFastifyReply,
  ) {
    const { deviceId } = req.params;
    return res.code(200).send(await this._manager.stop(deviceId));
  }

  updateParams(
    req: BaseFastifyRequest<typeof UPDATE_PARAMS_INPUT>,
    res: BaseFastifyReply,
  ) {
    const { deviceId } = req.params;
    const params = assertKnownParams(deviceId, req.body);
    return res.code(200).send(this._manager.updateParams(deviceId, params));
  }
}

/**
 * Rejects a body carrying knobs the addressed device does not have.
 *
 * The route schema is a union of the two devices' parameter objects and cannot
 * tell which half applies, because the device is named in the path. Without
 * this check, `PATCH /devices/good/params {"speedup": 2}` validates, clamps
 * away to nothing, and answers 200 — an operator would turn a knob, see the
 * request succeed, and watch for an effect that was never going to arrive.
 * Silently ignoring an instruction is the one outcome this feature cannot
 * afford, since the whole point of it is to trust what the meter shows.
 *
 * @throws 400 `UNKNOWN_DEVICE_PARAMS`
 */
function assertKnownParams(
  deviceId: DeviceId,
  params: unknown,
): Record<string, unknown> {
  if (params === undefined || params === null) return {};

  const known = deviceId === 'good' ? GOOD_PARAM_KEYS : FAULT_PARAM_KEYS;
  const body = params as Record<string, unknown>;
  const unknownKeys = Object.keys(body).filter((key) => !known.includes(key));

  if (unknownKeys.length > 0) {
    // Its own code rather than the schema validator's `VALIDATION_ERROR`: the
    // BFF passes the code through to the operator, and "you addressed the wrong
    // device" is a different mistake from "that value is out of range".
    throw new BaseHttpError(
      400,
      'UNKNOWN_DEVICE_PARAMS',
      `The "${deviceId}" device has no parameter ${unknownKeys.map((key) => `"${key}"`).join(', ')}. Its knobs are: ${known.join(', ')}.`,
      { unknownParams: unknownKeys, knownParams: known },
    );
  }
  return body;
}
