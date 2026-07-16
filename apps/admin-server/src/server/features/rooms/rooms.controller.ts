import type {
  BaseFastifyReply,
  BaseFastifyRequest,
} from '@scribear/base-fastify-server';

import type { AppDependencies } from '#src/server/dependency-injection/app-dependencies.js';
import { okEnvelope } from '#src/server/shared/envelope/envelope.js';
import { auditedMutation } from '#src/server/shared/proxy/audited-proxy.js';

import type {
  ADD_DEVICE_INPUT,
  CREATE_ROOM_INPUT,
  DELETE_ROOM_INPUT,
  GET_ROOM_INPUT,
  LIST_ROOMS_INPUT,
  REMOVE_DEVICE_INPUT,
  ROOM_DETAIL_INPUT,
  SET_SOURCE_INPUT,
  UPDATE_ROOM_INPUT,
} from './rooms.schema.js';

export class RoomsController {
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
    req: BaseFastifyRequest<typeof LIST_ROOMS_INPUT>,
    res: BaseFastifyReply,
  ) {
    this._gateway.respond(req, res, await this._gateway.listRooms(req.query));
  }

  async get(
    req: BaseFastifyRequest<typeof GET_ROOM_INPUT>,
    res: BaseFastifyReply,
  ) {
    this._gateway.respond(req, res, await this._gateway.getRoom(req.params));
  }

  /**
   * Aggregate view: the room plus its member devices. Fetching devices is
   * best-effort — a room that resolves but whose device list fails still
   * returns the room with an empty device list.
   */
  async detail(
    req: BaseFastifyRequest<typeof ROOM_DETAIL_INPUT>,
    res: BaseFastifyReply,
  ) {
    const [roomResponse, roomError] = await this._gateway.getRoom(req.params);
    if (roomResponse?.status !== 200) {
      this._gateway.respond(req, res, [roomResponse, roomError]);
      return;
    }

    const [devicesResponse] = await this._gateway.listDevices({
      roomUid: req.params.roomUid,
      limit: 200,
    });
    const devices =
      devicesResponse?.status === 200 ? devicesResponse.data.items : [];

    res.code(200).send(okEnvelope({ room: roomResponse.data, devices }));
  }

  // ---- Mutations (require read-write + CSRF) ----

  async create(
    req: BaseFastifyRequest<typeof CREATE_ROOM_INPUT>,
    res: BaseFastifyReply,
  ) {
    await auditedMutation({
      gateway: this._gateway,
      auditService: this._auditService,
      req,
      reply: res,
      action: 'create-room',
      target: null,
      paramsSummary: {
        name: req.body.name,
        timezone: req.body.timezone,
        sourceDeviceUids: req.body.sourceDeviceUids,
      },
      call: () => this._gateway.createRoom(req.body),
    });
  }

  async update(
    req: BaseFastifyRequest<typeof UPDATE_ROOM_INPUT>,
    res: BaseFastifyReply,
  ) {
    await auditedMutation({
      gateway: this._gateway,
      auditService: this._auditService,
      req,
      reply: res,
      action: 'update-room',
      target: req.body.roomUid,
      paramsSummary: { name: req.body.name },
      call: () => this._gateway.updateRoom(req.body),
    });
  }

  async delete(
    req: BaseFastifyRequest<typeof DELETE_ROOM_INPUT>,
    res: BaseFastifyReply,
  ) {
    await auditedMutation({
      gateway: this._gateway,
      auditService: this._auditService,
      req,
      reply: res,
      action: 'delete-room',
      target: req.body.roomUid,
      paramsSummary: {},
      call: () => this._gateway.deleteRoom(req.body),
    });
  }

  async addDevice(
    req: BaseFastifyRequest<typeof ADD_DEVICE_INPUT>,
    res: BaseFastifyReply,
  ) {
    await auditedMutation({
      gateway: this._gateway,
      auditService: this._auditService,
      req,
      reply: res,
      action: 'add-device-to-room',
      target: req.body.roomUid,
      paramsSummary: {
        deviceUid: req.body.deviceUid,
        asSource: req.body.asSource,
      },
      call: () => this._gateway.addDeviceToRoom(req.body),
    });
  }

  async removeDevice(
    req: BaseFastifyRequest<typeof REMOVE_DEVICE_INPUT>,
    res: BaseFastifyReply,
  ) {
    await auditedMutation({
      gateway: this._gateway,
      auditService: this._auditService,
      req,
      reply: res,
      action: 'remove-device-from-room',
      target: req.body.deviceUid,
      paramsSummary: {},
      call: () => this._gateway.removeDeviceFromRoom(req.body),
    });
  }

  async setSource(
    req: BaseFastifyRequest<typeof SET_SOURCE_INPUT>,
    res: BaseFastifyReply,
  ) {
    await auditedMutation({
      gateway: this._gateway,
      auditService: this._auditService,
      req,
      reply: res,
      action: 'set-source-device',
      target: req.body.roomUid,
      paramsSummary: { deviceUid: req.body.deviceUid },
      call: () => this._gateway.setSourceDevice(req.body),
    });
  }
}
