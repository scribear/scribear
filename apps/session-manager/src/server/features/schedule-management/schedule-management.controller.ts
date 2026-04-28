import {
  type BaseFastifyReply,
  type BaseFastifyRequest,
  HttpError,
} from '@scribear/base-fastify-server';
import type { Json } from '@scribear/scribear-db';
import {
  CREATE_AUTO_SESSION_WINDOW_SCHEMA,
  CREATE_ON_DEMAND_SESSION_SCHEMA,
  CREATE_SCHEDULE_SCHEMA,
  DELETE_AUTO_SESSION_WINDOW_SCHEMA,
  DELETE_SCHEDULE_SCHEMA,
  END_SESSION_EARLY_SCHEMA,
  GET_AUTO_SESSION_WINDOW_SCHEMA,
  GET_SCHEDULE_SCHEMA,
  GET_SESSION_SCHEMA,
  LIST_AUTO_SESSION_WINDOWS_SCHEMA,
  LIST_SCHEDULES_SCHEMA,
  MY_SCHEDULE_SCHEMA,
  SESSION_CONFIG_STREAM_SCHEMA,
  START_SESSION_EARLY_SCHEMA,
  UPDATE_AUTO_SESSION_WINDOW_SCHEMA,
  UPDATE_ROOM_SCHEDULE_CONFIG_SCHEMA,
  UPDATE_SCHEDULE_SCHEMA,
} from '@scribear/session-manager-schema';

import type { AppDependencies } from '#src/server/dependency-injection/app-dependencies.js';
import type {
  AutoSessionWindow,
  Schedule,
  Session,
} from '#src/server/features/schedule-management/schedule-management.repository.js';
import {
  RoomScheduleVersionBumpedChannel,
  SessionConfigVersionBumpedChannel,
} from '#src/server/shared/events/schedule-management.events.js';

const LONG_POLL_TIMEOUT_MS = 25_000;
const SESSION_WINDOW_DAYS = 7;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export class ScheduleManagementController {
  private _scheduleService: AppDependencies['scheduleManagementService'];
  private _roomService: AppDependencies['roomManagementService'];
  private _eventBus: AppDependencies['eventBusService'];

  constructor(
    scheduleManagementService: AppDependencies['scheduleManagementService'],
    roomManagementService: AppDependencies['roomManagementService'],
    eventBusService: AppDependencies['eventBusService'],
  ) {
    this._scheduleService = scheduleManagementService;
    this._roomService = roomManagementService;
    this._eventBus = eventBusService;
  }

  async listSchedules(
    req: BaseFastifyRequest<typeof LIST_SCHEDULES_SCHEMA>,
    res: BaseFastifyReply<typeof LIST_SCHEDULES_SCHEMA>,
  ) {
    const { roomUid, from, to } = req.query;

    const result = await this._scheduleService.listSchedulesForRoom(roomUid, {
      ...(from !== undefined && { from: new Date(from) }),
      ...(to !== undefined && { to: new Date(to) }),
    });

    if (result === 'ROOM_NOT_FOUND')
      throw HttpError.notFound('ROOM_NOT_FOUND', 'Room not found.');

    res.code(200).send({ items: result.map((s) => this._mapSchedule(s)) });
  }

  async createSchedule(
    req: BaseFastifyRequest<typeof CREATE_SCHEDULE_SCHEMA>,
    res: BaseFastifyReply<typeof CREATE_SCHEDULE_SCHEMA>,
  ) {
    const {
      roomUid,
      activeStart,
      activeEnd,
      transcriptionStreamConfig,
      ...rest
    } = req.body;

    const result = await this._scheduleService.createSchedule(
      {
        ...rest,
        roomUid,
        activeStart: new Date(activeStart),
        activeEnd: activeEnd != null ? new Date(activeEnd) : null,
        transcriptionStreamConfig: transcriptionStreamConfig as Json,
      },
      new Date(),
    );

    if (result === 'ROOM_NOT_FOUND')
      throw HttpError.notFound('ROOM_NOT_FOUND', 'Room not found.');
    if (result === 'CONFLICT')
      throw HttpError.conflict(
        'CONFLICT',
        'Schedule conflicts with an existing one.',
      );
    if (result === 'INVALID_ACTIVE_START')
      throw HttpError.unprocessable(
        'INVALID_ACTIVE_START',
        'Schedule activeStart must be strictly in the future.',
      );
    if (result === 'INVALID_ACTIVE_END')
      throw HttpError.badRequest(
        'activeEnd must be strictly after activeStart.',
      );
    if (result === 'INVALID_LOCAL_TIMES')
      throw HttpError.badRequest(
        'localStartTime and localEndTime must not be equal.',
      );
    if (result === 'INVALID_FREQUENCY_FIELDS')
      throw HttpError.badRequest(
        'daysOfWeek must be null for ONCE schedules and a non-empty array for WEEKLY or BIWEEKLY schedules.',
      );

    res.code(201).send(this._mapSchedule(result));
  }

  async getSchedule(
    req: BaseFastifyRequest<typeof GET_SCHEDULE_SCHEMA>,
    res: BaseFastifyReply<typeof GET_SCHEDULE_SCHEMA>,
  ) {
    const result = await this._scheduleService.findScheduleByUid(
      req.params.scheduleUid,
    );
    if (result === 'NOT_FOUND')
      throw HttpError.notFound('SCHEDULE_NOT_FOUND', 'Schedule not found.');

    res.code(200).send(this._mapSchedule(result));
  }

  async updateSchedule(
    req: BaseFastifyRequest<typeof UPDATE_SCHEDULE_SCHEMA>,
    res: BaseFastifyReply<typeof UPDATE_SCHEDULE_SCHEMA>,
  ) {
    const {
      scheduleUid,
      activeStart,
      activeEnd,
      transcriptionStreamConfig,
      ...rest
    } = req.body;

    const result = await this._scheduleService.updateSchedule(
      scheduleUid,
      {
        ...rest,
        ...(activeStart !== undefined && {
          activeStart: new Date(activeStart),
        }),
        ...(activeEnd !== undefined && {
          activeEnd: activeEnd != null ? new Date(activeEnd) : null,
        }),
        ...(transcriptionStreamConfig !== undefined && {
          transcriptionStreamConfig: transcriptionStreamConfig as Json,
        }),
      },
      new Date(),
    );

    if (result === 'NOT_FOUND')
      throw HttpError.notFound('SCHEDULE_NOT_FOUND', 'Schedule not found.');
    if (result === 'CONFLICT')
      throw HttpError.conflict(
        'CONFLICT',
        'Schedule conflicts with an existing one.',
      );
    if (result === 'INVALID_ACTIVE_START')
      throw HttpError.unprocessable(
        'INVALID_ACTIVE_START',
        'Schedule activeStart must be strictly in the future.',
      );
    if (result === 'INVALID_ACTIVE_END')
      throw HttpError.badRequest(
        'activeEnd must be strictly after activeStart.',
      );
    if (result === 'INVALID_LOCAL_TIMES')
      throw HttpError.badRequest(
        'localStartTime and localEndTime must not be equal.',
      );
    if (result === 'INVALID_FREQUENCY_FIELDS')
      throw HttpError.badRequest(
        'daysOfWeek must be null for ONCE schedules and a non-empty array for WEEKLY or BIWEEKLY schedules.',
      );

    res.code(200).send(this._mapSchedule(result));
  }

  async deleteSchedule(
    req: BaseFastifyRequest<typeof DELETE_SCHEDULE_SCHEMA>,
    res: BaseFastifyReply<typeof DELETE_SCHEDULE_SCHEMA>,
  ) {
    const result = await this._scheduleService.deleteSchedule(
      req.body.scheduleUid,
      new Date(),
    );
    if (result === 'NOT_FOUND')
      throw HttpError.notFound('SCHEDULE_NOT_FOUND', 'Schedule not found.');

    res.code(204).send(null);
  }

  async listAutoSessionWindows(
    req: BaseFastifyRequest<typeof LIST_AUTO_SESSION_WINDOWS_SCHEMA>,
    res: BaseFastifyReply<typeof LIST_AUTO_SESSION_WINDOWS_SCHEMA>,
  ) {
    const { roomUid, from, to } = req.query;

    const result = await this._scheduleService.listAutoSessionWindowsForRoom(
      roomUid,
      {
        ...(from !== undefined && { from: new Date(from) }),
        ...(to !== undefined && { to: new Date(to) }),
      },
    );

    if (result === 'ROOM_NOT_FOUND')
      throw HttpError.notFound('ROOM_NOT_FOUND', 'Room not found.');

    res.code(200).send({ items: result.map((w) => this._mapWindow(w)) });
  }

  async createAutoSessionWindow(
    req: BaseFastifyRequest<typeof CREATE_AUTO_SESSION_WINDOW_SCHEMA>,
    res: BaseFastifyReply<typeof CREATE_AUTO_SESSION_WINDOW_SCHEMA>,
  ) {
    const {
      roomUid,
      activeStart,
      activeEnd,
      transcriptionStreamConfig,
      ...rest
    } = req.body;

    const result = await this._scheduleService.createAutoSessionWindow(
      {
        ...rest,
        roomUid,
        activeStart: new Date(activeStart),
        activeEnd: activeEnd != null ? new Date(activeEnd) : null,
        transcriptionStreamConfig: transcriptionStreamConfig as Json,
      },
      new Date(),
    );

    if (result === 'ROOM_NOT_FOUND')
      throw HttpError.notFound('ROOM_NOT_FOUND', 'Room not found.');
    if (result === 'CONFLICT')
      throw HttpError.conflict(
        'CONFLICT',
        'Window conflicts with an existing one.',
      );
    if (result === 'INVALID_ACTIVE_END')
      throw HttpError.unprocessable(
        'INVALID_ACTIVE_END',
        'activeEnd must be strictly after activeStart.',
      );

    res.code(201).send(this._mapWindow(result));
  }

  async getAutoSessionWindow(
    req: BaseFastifyRequest<typeof GET_AUTO_SESSION_WINDOW_SCHEMA>,
    res: BaseFastifyReply<typeof GET_AUTO_SESSION_WINDOW_SCHEMA>,
  ) {
    const result = await this._scheduleService.findAutoSessionWindowByUid(
      req.params.windowUid,
    );
    if (result === 'NOT_FOUND')
      throw HttpError.notFound(
        'WINDOW_NOT_FOUND',
        'Auto-session window not found.',
      );

    res.code(200).send(this._mapWindow(result));
  }

  async updateAutoSessionWindow(
    req: BaseFastifyRequest<typeof UPDATE_AUTO_SESSION_WINDOW_SCHEMA>,
    res: BaseFastifyReply<typeof UPDATE_AUTO_SESSION_WINDOW_SCHEMA>,
  ) {
    const {
      windowUid,
      activeStart,
      activeEnd,
      transcriptionStreamConfig,
      ...rest
    } = req.body;

    const result = await this._scheduleService.updateAutoSessionWindow(
      windowUid,
      {
        ...rest,
        ...(activeStart !== undefined && {
          activeStart: new Date(activeStart),
        }),
        ...(activeEnd !== undefined && {
          activeEnd: activeEnd != null ? new Date(activeEnd) : null,
        }),
        ...(transcriptionStreamConfig !== undefined && {
          transcriptionStreamConfig: transcriptionStreamConfig as Json,
        }),
      },
      new Date(),
    );

    if (result === 'NOT_FOUND')
      throw HttpError.notFound(
        'WINDOW_NOT_FOUND',
        'Auto-session window not found.',
      );
    if (result === 'CONFLICT')
      throw HttpError.conflict(
        'CONFLICT',
        'Window conflicts with an existing one.',
      );
    if (result === 'INVALID_ACTIVE_END')
      throw HttpError.unprocessable(
        'INVALID_ACTIVE_END',
        'activeEnd must be strictly after activeStart.',
      );

    res.code(200).send(this._mapWindow(result));
  }

  async deleteAutoSessionWindow(
    req: BaseFastifyRequest<typeof DELETE_AUTO_SESSION_WINDOW_SCHEMA>,
    res: BaseFastifyReply<typeof DELETE_AUTO_SESSION_WINDOW_SCHEMA>,
  ) {
    const result = await this._scheduleService.deleteAutoSessionWindow(
      req.body.windowUid,
      new Date(),
    );
    if (result === 'NOT_FOUND')
      throw HttpError.notFound(
        'WINDOW_NOT_FOUND',
        'Auto-session window not found.',
      );

    res.code(204).send(null);
  }

  async updateRoomScheduleConfig(
    req: BaseFastifyRequest<typeof UPDATE_ROOM_SCHEDULE_CONFIG_SCHEMA>,
    res: BaseFastifyReply<typeof UPDATE_ROOM_SCHEDULE_CONFIG_SCHEMA>,
  ) {
    const { roomUid, ...data } = req.body;

    const result = await this._scheduleService.updateRoomScheduleConfig(
      roomUid,
      data,
      new Date(),
    );

    if (result === 'ROOM_NOT_FOUND')
      throw HttpError.notFound('ROOM_NOT_FOUND', 'Room not found.');

    const room = await this._roomService.getRoom(roomUid);
    if (room === 'ROOM_NOT_FOUND') throw HttpError.internal();

    res.code(200).send({ ...room, createdAt: room.createdAt.toISOString() });
  }

  async getSession(
    req: BaseFastifyRequest<typeof GET_SESSION_SCHEMA>,
    res: BaseFastifyReply<typeof GET_SESSION_SCHEMA>,
  ) {
    const result = await this._scheduleService.getSession(
      req.params.sessionUid,
    );
    if (result === 'NOT_FOUND')
      throw HttpError.notFound('SESSION_NOT_FOUND', 'Session not found.');

    res.code(200).send(this._mapSession(result));
  }

  async createOnDemandSession(
    req: BaseFastifyRequest<typeof CREATE_ON_DEMAND_SESSION_SCHEMA>,
    res: BaseFastifyReply<typeof CREATE_ON_DEMAND_SESSION_SCHEMA>,
  ) {
    const { transcriptionStreamConfig, ...rest } = req.body;

    const result = await this._scheduleService.createOnDemandSession(
      { ...rest, transcriptionStreamConfig: transcriptionStreamConfig as Json },
      new Date(),
    );

    if (result === 'ROOM_NOT_FOUND')
      throw HttpError.notFound('ROOM_NOT_FOUND', 'Room not found.');
    if (result === 'ANOTHER_SESSION_ACTIVE')
      throw HttpError.conflict(
        'ANOTHER_SESSION_ACTIVE',
        'A non-AUTO session is currently active in this room.',
      );

    res.code(201).send(this._mapSession(result));
  }

  async startSessionEarly(
    req: BaseFastifyRequest<typeof START_SESSION_EARLY_SCHEMA>,
    res: BaseFastifyReply<typeof START_SESSION_EARLY_SCHEMA>,
  ) {
    const result = await this._scheduleService.startSessionEarly(
      req.body.sessionUid,
      new Date(),
    );

    if (result === 'NOT_FOUND')
      throw HttpError.notFound('SESSION_NOT_FOUND', 'Session not found.');
    if (result === 'SESSION_IS_AUTO')
      throw HttpError.unprocessable(
        'SESSION_IS_AUTO',
        'AUTO sessions cannot be started early.',
      );
    if (result === 'NOT_NEXT_UPCOMING')
      throw HttpError.conflict(
        'NOT_NEXT_UPCOMING',
        'Session is not the next upcoming session in this room.',
      );
    if (result === 'ANOTHER_SESSION_ACTIVE')
      throw HttpError.conflict(
        'ANOTHER_SESSION_ACTIVE',
        'A non-AUTO session is currently active in this room.',
      );

    res.code(200).send(this._mapSession(result));
  }

  async endSessionEarly(
    req: BaseFastifyRequest<typeof END_SESSION_EARLY_SCHEMA>,
    res: BaseFastifyReply<typeof END_SESSION_EARLY_SCHEMA>,
  ) {
    const result = await this._scheduleService.endSessionEarly(
      req.body.sessionUid,
      new Date(),
    );

    if (result === 'NOT_FOUND')
      throw HttpError.notFound('SESSION_NOT_FOUND', 'Session not found.');
    if (result === 'SESSION_IS_AUTO')
      throw HttpError.unprocessable(
        'SESSION_IS_AUTO',
        'AUTO sessions cannot be ended early.',
      );
    if (result === 'SESSION_NOT_ACTIVE')
      throw HttpError.unprocessable(
        'SESSION_NOT_ACTIVE',
        'Session is not currently active.',
      );

    res.code(200).send(this._mapSession(result));
  }

  async mySchedule(
    req: BaseFastifyRequest<typeof MY_SCHEDULE_SCHEMA>,
    res: BaseFastifyReply<typeof MY_SCHEDULE_SCHEMA>,
  ) {
    if (!req.deviceUid) throw HttpError.internal();

    const room = await this._roomService.getMyRoom(req.deviceUid);
    if (room === 'DEVICE_NOT_IN_ROOM')
      throw HttpError.notFound(
        'DEVICE_NOT_IN_ROOM',
        'Device is not a member of any room.',
      );

    const { sinceVersion } = req.query;

    // Respond immediately if the room already has a newer version.
    if (room.roomScheduleVersion > sinceVersion) {
      res
        .code(200)
        .send(
          await this._buildSchedulePayload(room.uid, room.roomScheduleVersion),
        );
      return;
    }

    // Hold the request until a bump fires or the timeout elapses.
    const event = await new Promise<{
      roomUid: string;
      roomScheduleVersion: number;
    } | null>((resolve) => {
      const timer = setTimeout(() => {
        unsub();
        resolve(null);
      }, LONG_POLL_TIMEOUT_MS);

      const unsub = this._eventBus.subscribe(
        RoomScheduleVersionBumpedChannel,
        (msg) => {
          clearTimeout(timer);
          unsub();
          resolve(msg);
        },
        room.uid,
      );

      req.socket.once('close', () => {
        clearTimeout(timer);
        unsub();
        resolve(null);
      });
    });

    if (event === null) {
      res.code(204).send(null);
      return;
    }

    res
      .code(200)
      .send(
        await this._buildSchedulePayload(
          event.roomUid,
          event.roomScheduleVersion,
        ),
      );
  }

  async sessionConfigStream(
    req: BaseFastifyRequest<typeof SESSION_CONFIG_STREAM_SCHEMA>,
    res: BaseFastifyReply<typeof SESSION_CONFIG_STREAM_SCHEMA>,
  ) {
    const { sessionUid } = req.params;
    const { sinceVersion } = req.query;

    const initial = await this._scheduleService.getSession(sessionUid);
    if (initial === 'NOT_FOUND')
      throw HttpError.notFound('SESSION_NOT_FOUND', 'Session not found.');

    if (initial.sessionConfigVersion > sinceVersion) {
      res.code(200).send(this._mapSession(initial));
      return;
    }

    const event = await new Promise<{
      sessionUid: string;
      sessionConfigVersion: number;
    } | null>((resolve) => {
      const timer = setTimeout(() => {
        unsub();
        resolve(null);
      }, LONG_POLL_TIMEOUT_MS);

      const unsub = this._eventBus.subscribe(
        SessionConfigVersionBumpedChannel,
        (msg) => {
          clearTimeout(timer);
          unsub();
          resolve(msg);
        },
        sessionUid,
      );

      req.socket.once('close', () => {
        clearTimeout(timer);
        unsub();
        resolve(null);
      });
    });

    if (event === null) {
      res.code(204).send(null);
      return;
    }

    const updated = await this._scheduleService.getSession(sessionUid);
    if (updated === 'NOT_FOUND') {
      // Session was deleted between the event and now; treat as timeout.
      res.code(204).send(null);
      return;
    }

    res.code(200).send(this._mapSession(updated));
  }

  private async _buildSchedulePayload(
    roomUid: string,
    roomScheduleVersion: number,
  ) {
    const now = new Date();
    const upTo = new Date(now.getTime() + SESSION_WINDOW_DAYS * MS_PER_DAY);
    const { active, upcoming } =
      await this._scheduleService.listActiveAndUpcomingSessions(
        roomUid,
        now,
        upTo,
      );
    return {
      roomUid,
      roomScheduleVersion,
      serverTime: now.toISOString(),
      sessions: [...(active ? [active] : []), ...upcoming].map((s) =>
        this._mapSession(s),
      ),
    };
  }

  private _mapSchedule(s: Schedule) {
    return {
      ...s,
      activeStart: s.activeStart.toISOString(),
      activeEnd: s.activeEnd?.toISOString() ?? null,
      anchorStart: s.anchorStart.toISOString(),
      createdAt: s.createdAt.toISOString(),
    };
  }

  private _mapWindow(w: AutoSessionWindow) {
    return {
      ...w,
      activeStart: w.activeStart.toISOString(),
      activeEnd: w.activeEnd?.toISOString() ?? null,
      createdAt: w.createdAt.toISOString(),
    };
  }

  private _mapSession(s: Session) {
    return {
      ...s,
      scheduledStartTime: s.scheduledStartTime.toISOString(),
      scheduledEndTime: s.scheduledEndTime?.toISOString() ?? null,
      startOverride: s.startOverride?.toISOString() ?? null,
      endOverride: s.endOverride?.toISOString() ?? null,
      effectiveStart: s.effectiveStart.toISOString(),
      effectiveEnd: s.effectiveEnd?.toISOString() ?? null,
      createdAt: s.createdAt.toISOString(),
    };
  }
}
