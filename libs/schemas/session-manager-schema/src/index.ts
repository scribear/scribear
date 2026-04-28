export { OPENAPI_INFO, OPENAPI_VERSION } from './metadata.js';
export * from './base-path.js';
export * from './shared/security/index.js';
export * from './tags.js';

export * from './shared/entities/pagination.schema.js';
export * from './shared/entities/session-scope.schema.js';

export * from './probes/routes/liveness.schema.js';
export * from './probes/routes/readiness.schema.js';

export * from './room-management/entities/room.schema.js';
export * from './room-management/routes/list-rooms.schema.js';
export * from './room-management/routes/get-room.schema.js';
export * from './room-management/routes/create-room.schema.js';
export * from './room-management/routes/update-room.schema.js';
export * from './room-management/routes/delete-room.schema.js';
export * from './room-management/routes/add-device-to-room.schema.js';
export * from './room-management/routes/remove-device-from-room.schema.js';
export * from './room-management/routes/set-source-device.schema.js';
export * from './room-management/routes/get-my-room.schema.js';

export * from './device-management/entities/device.schema.js';
export * from './device-management/routes/list-devices.schema.js';
export * from './device-management/routes/get-device.schema.js';
export * from './device-management/routes/register-device.schema.js';
export * from './device-management/routes/reregister-device.schema.js';
export * from './device-management/routes/activate-device.schema.js';
export * from './device-management/routes/update-device.schema.js';
export * from './device-management/routes/delete-device.schema.js';
export * from './device-management/routes/get-my-device.schema.js';

export * from './schedule-management/entities/day-of-week.schema.js';
export * from './schedule-management/entities/schedule-frequency.schema.js';
export * from './schedule-management/entities/session-schedule.schema.js';
export * from './schedule-management/entities/session-type.schema.js';
export * from './schedule-management/entities/session.schema.js';
export * from './schedule-management/entities/auto-session-window.schema.js';

export * from './schedule-management/routes/my-schedule.schema.js';
export * from './schedule-management/routes/list-schedules.schema.js';
export * from './schedule-management/routes/create-schedule.schema.js';
export * from './schedule-management/routes/get-schedule.schema.js';
export * from './schedule-management/routes/update-schedule.schema.js';
export * from './schedule-management/routes/delete-schedule.schema.js';
export * from './schedule-management/routes/update-room-schedule-config.schema.js';
export * from './schedule-management/routes/create-auto-session-window.schema.js';
export * from './schedule-management/routes/get-auto-session-window.schema.js';
export * from './schedule-management/routes/update-auto-session-window.schema.js';
export * from './schedule-management/routes/delete-auto-session-window.schema.js';
export * from './schedule-management/routes/get-session.schema.js';
export * from './schedule-management/routes/create-on-demand-session.schema.js';
export * from './schedule-management/routes/start-session-early.schema.js';
export * from './schedule-management/routes/end-session-early.schema.js';
export * from './schedule-management/routes/session-config-stream.schema.js';

export * from './session-auth/entities/session-token-payload.schema.js';
export * from './session-auth/routes/fetch-join-code.schema.js';
export * from './session-auth/routes/exchange-device-token.schema.js';
export * from './session-auth/routes/exchange-join-code.schema.js';
export * from './session-auth/routes/refresh-session-token.schema.js';
