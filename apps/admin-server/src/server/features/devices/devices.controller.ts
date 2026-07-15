import type {
  BaseFastifyReply,
  BaseFastifyRequest,
} from '@scribear/base-fastify-server';

import type { AppDependencies } from '#src/server/dependency-injection/app-dependencies.js';
import { auditedMutation } from '#src/server/shared/proxy/audited-proxy.js';

import type {
  DELETE_DEVICE_INPUT,
  GET_DEVICE_INPUT,
  LIST_DEVICES_INPUT,
  REGISTER_DEVICE_INPUT,
  REREGISTER_DEVICE_INPUT,
  UPDATE_DEVICE_INPUT,
} from './devices.schema.js';

export class DevicesController {
  private _gateway: AppDependencies['sessionManagerGatewayService'];
  private _auditService: AppDependencies['auditService'];

  constructor(
    sessionManagerGatewayService: AppDependencies['sessionManagerGatewayService'],
    auditService: AppDependencies['auditService'],
  ) {
    this._gateway = sessionManagerGatewayService;
    this._auditService = auditService;
  }

  // ---- Reads ----

  async list(
    req: BaseFastifyRequest<typeof LIST_DEVICES_INPUT>,
    res: BaseFastifyReply,
  ) {
    this._gateway.respond(req, res, await this._gateway.listDevices(req.query));
  }

  async get(
    req: BaseFastifyRequest<typeof GET_DEVICE_INPUT>,
    res: BaseFastifyReply,
  ) {
    this._gateway.respond(req, res, await this._gateway.getDevice(req.params));
  }

  // ---- Mutations (require read-write + CSRF) ----

  async register(
    req: BaseFastifyRequest<typeof REGISTER_DEVICE_INPUT>,
    res: BaseFastifyReply,
  ) {
    await auditedMutation({
      gateway: this._gateway,
      auditService: this._auditService,
      req,
      reply: res,
      action: 'register-device',
      target: null,
      paramsSummary: { name: req.body.name },
      call: () => this._gateway.registerDevice(req.body),
    });
  }

  async reregister(
    req: BaseFastifyRequest<typeof REREGISTER_DEVICE_INPUT>,
    res: BaseFastifyReply,
  ) {
    await auditedMutation({
      gateway: this._gateway,
      auditService: this._auditService,
      req,
      reply: res,
      action: 'reregister-device',
      target: req.body.deviceUid,
      paramsSummary: {},
      call: () => this._gateway.reregisterDevice(req.body),
    });
  }

  async update(
    req: BaseFastifyRequest<typeof UPDATE_DEVICE_INPUT>,
    res: BaseFastifyReply,
  ) {
    await auditedMutation({
      gateway: this._gateway,
      auditService: this._auditService,
      req,
      reply: res,
      action: 'update-device',
      target: req.body.deviceUid,
      paramsSummary: { name: req.body.name },
      call: () => this._gateway.updateDevice(req.body),
    });
  }

  async delete(
    req: BaseFastifyRequest<typeof DELETE_DEVICE_INPUT>,
    res: BaseFastifyReply,
  ) {
    await auditedMutation({
      gateway: this._gateway,
      auditService: this._auditService,
      req,
      reply: res,
      action: 'delete-device',
      target: req.body.deviceUid,
      paramsSummary: {},
      call: () => this._gateway.deleteDevice(req.body),
    });
  }
}
