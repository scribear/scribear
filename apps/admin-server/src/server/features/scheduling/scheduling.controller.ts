import type {
  BaseFastifyReply,
  BaseFastifyRequest,
} from '@scribear/base-fastify-server';

import type { AppDependencies } from '#src/server/dependency-injection/app-dependencies.js';
import { auditedMutation } from '#src/server/shared/proxy/audited-proxy.js';

import type {
  CREATE_AUTO_SESSION_WINDOW_INPUT,
  CREATE_ON_DEMAND_SESSION_INPUT,
  CREATE_SCHEDULE_INPUT,
  DELETE_AUTO_SESSION_WINDOW_INPUT,
  DELETE_SCHEDULE_INPUT,
  END_SESSION_EARLY_INPUT,
  GET_ACTIVE_SESSION_INPUT,
  GET_AUTO_SESSION_WINDOW_INPUT,
  GET_SCHEDULE_INPUT,
  GET_SESSION_INPUT,
  GET_SESSION_JOIN_CODE_INPUT,
  LIST_AUTO_SESSION_WINDOWS_INPUT,
  LIST_SCHEDULES_INPUT,
  LIST_SESSIONS_INPUT,
  START_SESSION_EARLY_INPUT,
  UPDATE_AUTO_SESSION_WINDOW_INPUT,
  UPDATE_ROOM_SCHEDULE_CONFIG_INPUT,
  UPDATE_SCHEDULE_INPUT,
} from './scheduling.schema.js';

export class SchedulingController {
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

  async listSchedules(
    req: BaseFastifyRequest<typeof LIST_SCHEDULES_INPUT>,
    res: BaseFastifyReply,
  ) {
    this._gateway.respond(
      req,
      res,
      await this._gateway.listSchedules(req.query),
    );
  }

  async getSchedule(
    req: BaseFastifyRequest<typeof GET_SCHEDULE_INPUT>,
    res: BaseFastifyReply,
  ) {
    this._gateway.respond(
      req,
      res,
      await this._gateway.getSchedule(req.params),
    );
  }

  async listAutoWindows(
    req: BaseFastifyRequest<typeof LIST_AUTO_SESSION_WINDOWS_INPUT>,
    res: BaseFastifyReply,
  ) {
    this._gateway.respond(
      req,
      res,
      await this._gateway.listAutoSessionWindows(req.query),
    );
  }

  async getAutoWindow(
    req: BaseFastifyRequest<typeof GET_AUTO_SESSION_WINDOW_INPUT>,
    res: BaseFastifyReply,
  ) {
    this._gateway.respond(
      req,
      res,
      await this._gateway.getAutoSessionWindow(req.params),
    );
  }

  async getSession(
    req: BaseFastifyRequest<typeof GET_SESSION_INPUT>,
    res: BaseFastifyReply,
  ) {
    this._gateway.respond(req, res, await this._gateway.getSession(req.params));
  }

  async listSessions(
    req: BaseFastifyRequest<typeof LIST_SESSIONS_INPUT>,
    res: BaseFastifyReply,
  ) {
    this._gateway.respond(
      req,
      res,
      await this._gateway.listSessions(req.query),
    );
  }

  async getActiveSession(
    req: BaseFastifyRequest<typeof GET_ACTIVE_SESSION_INPUT>,
    res: BaseFastifyReply,
  ) {
    this._gateway.respond(
      req,
      res,
      await this._gateway.getActiveSession(req.params),
    );
  }

  async getSessionJoinCode(
    req: BaseFastifyRequest<typeof GET_SESSION_JOIN_CODE_INPUT>,
    res: BaseFastifyReply,
  ) {
    this._gateway.respond(
      req,
      res,
      await this._gateway.getSessionJoinCode(req.params),
    );
  }

  // ---- Mutations (require read-write + CSRF) ----

  async createSchedule(
    req: BaseFastifyRequest<typeof CREATE_SCHEDULE_INPUT>,
    res: BaseFastifyReply,
  ) {
    await auditedMutation({
      gateway: this._gateway,
      auditService: this._auditService,
      req,
      reply: res,
      action: 'create-schedule',
      target: null,
      paramsSummary: {
        name: req.body.name,
        roomUid: req.body.roomUid,
      },
      call: () => this._gateway.createSchedule(req.body),
    });
  }

  async updateSchedule(
    req: BaseFastifyRequest<typeof UPDATE_SCHEDULE_INPUT>,
    res: BaseFastifyReply,
  ) {
    await auditedMutation({
      gateway: this._gateway,
      auditService: this._auditService,
      req,
      reply: res,
      action: 'update-schedule',
      target: req.body.scheduleUid,
      paramsSummary: { name: req.body.name },
      call: () => this._gateway.updateSchedule(req.body),
    });
  }

  async deleteSchedule(
    req: BaseFastifyRequest<typeof DELETE_SCHEDULE_INPUT>,
    res: BaseFastifyReply,
  ) {
    await auditedMutation({
      gateway: this._gateway,
      auditService: this._auditService,
      req,
      reply: res,
      action: 'delete-schedule',
      target: req.body.scheduleUid,
      paramsSummary: {},
      call: () => this._gateway.deleteSchedule(req.body),
    });
  }

  async createAutoWindow(
    req: BaseFastifyRequest<typeof CREATE_AUTO_SESSION_WINDOW_INPUT>,
    res: BaseFastifyReply,
  ) {
    await auditedMutation({
      gateway: this._gateway,
      auditService: this._auditService,
      req,
      reply: res,
      action: 'create-auto-session-window',
      target: null,
      paramsSummary: { roomUid: req.body.roomUid },
      call: () => this._gateway.createAutoSessionWindow(req.body),
    });
  }

  async updateAutoWindow(
    req: BaseFastifyRequest<typeof UPDATE_AUTO_SESSION_WINDOW_INPUT>,
    res: BaseFastifyReply,
  ) {
    await auditedMutation({
      gateway: this._gateway,
      auditService: this._auditService,
      req,
      reply: res,
      action: 'update-auto-session-window',
      target: req.body.windowUid,
      paramsSummary: {},
      call: () => this._gateway.updateAutoSessionWindow(req.body),
    });
  }

  async deleteAutoWindow(
    req: BaseFastifyRequest<typeof DELETE_AUTO_SESSION_WINDOW_INPUT>,
    res: BaseFastifyReply,
  ) {
    await auditedMutation({
      gateway: this._gateway,
      auditService: this._auditService,
      req,
      reply: res,
      action: 'delete-auto-session-window',
      target: req.body.windowUid,
      paramsSummary: {},
      call: () => this._gateway.deleteAutoSessionWindow(req.body),
    });
  }

  async updateRoomScheduleConfig(
    req: BaseFastifyRequest<typeof UPDATE_ROOM_SCHEDULE_CONFIG_INPUT>,
    res: BaseFastifyReply,
  ) {
    await auditedMutation({
      gateway: this._gateway,
      auditService: this._auditService,
      req,
      reply: res,
      action: 'update-room-schedule-config',
      target: req.body.roomUid,
      paramsSummary: {
        autoSessionEnabled: req.body.autoSessionEnabled ?? null,
      },
      call: () => this._gateway.updateRoomScheduleConfig(req.body),
    });
  }

  async createOnDemandSession(
    req: BaseFastifyRequest<typeof CREATE_ON_DEMAND_SESSION_INPUT>,
    res: BaseFastifyReply,
  ) {
    await auditedMutation({
      gateway: this._gateway,
      auditService: this._auditService,
      req,
      reply: res,
      action: 'create-on-demand-session',
      target: null,
      paramsSummary: {
        name: req.body.name,
        roomUid: req.body.roomUid,
      },
      call: () => this._gateway.createOnDemandSession(req.body),
    });
  }

  async startSessionEarly(
    req: BaseFastifyRequest<typeof START_SESSION_EARLY_INPUT>,
    res: BaseFastifyReply,
  ) {
    await auditedMutation({
      gateway: this._gateway,
      auditService: this._auditService,
      req,
      reply: res,
      action: 'start-session-early',
      target: req.body.sessionUid,
      paramsSummary: {},
      call: () => this._gateway.startSessionEarly(req.body),
    });
  }

  async endSessionEarly(
    req: BaseFastifyRequest<typeof END_SESSION_EARLY_INPUT>,
    res: BaseFastifyReply,
  ) {
    await auditedMutation({
      gateway: this._gateway,
      auditService: this._auditService,
      req,
      reply: res,
      action: 'end-session-early',
      target: req.body.sessionUid,
      paramsSummary: {},
      call: () => this._gateway.endSessionEarly(req.body),
    });
  }
}
