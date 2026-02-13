import { Type } from 'typebox';

import {
  type BaseRouteSchema,
  SHARED_ERROR_REPLY_SCHEMA,
} from '@scribear/base-schema';

const ScheduledSessionResponse = Type.Object({
  id: Type.String({ description: 'Unique scheduled session identifier' }),
  kioskId: Type.String({ description: 'ID of the assigned kiosk' }),
  title: Type.String({ description: 'Session title' }),
  sessionLength: Type.Integer({ description: 'Session duration in seconds' }),
  scheduledAt: Type.String({
    description: 'ISO 8601 timestamp for when session is scheduled',
  }),
  recurrenceRule: Type.Union([Type.String(), Type.Null()], {
    description:
      'Recurrence rule (e.g. RRULE string) or null for one-time sessions',
  }),
});

// ─── CREATE ───

const CREATE_SCHEDULED_SESSION_SCHEMA = {
  description: 'Creates a new scheduled session',
  tags: ['Scheduled Sessions'],
  body: Type.Object(
    {
      kioskId: Type.String({
        description: 'ID of the kiosk to assign to this session',
      }),
      title: Type.String({
        description: 'Session title',
        minLength: 1,
        maxLength: 255,
      }),
      sessionLength: Type.Integer({
        description: 'Session duration in seconds',
        minimum: 60,
        maximum: 86400,
      }),
      scheduledAt: Type.String({
        description: 'ISO 8601 timestamp for when session should start',
      }),
      recurrenceRule: Type.Optional(
        Type.Union([Type.String(), Type.Null()], {
          description: 'Recurrence rule or null for one-time sessions',
        }),
      ),
    },
    { description: 'Scheduled session creation request' },
  ),
  response: {
    201: ScheduledSessionResponse,
    400: SHARED_ERROR_REPLY_SCHEMA[400],
    500: SHARED_ERROR_REPLY_SCHEMA[500],
  },
};

const CREATE_SCHEDULED_SESSION_ROUTE: BaseRouteSchema = {
  method: 'POST',
  url: '/api/v1/scheduled-sessions',
};

// ─── GET BY ID ───

const GET_SCHEDULED_SESSION_SCHEMA = {
  description: 'Gets a scheduled session by ID',
  tags: ['Scheduled Sessions'],
  params: Type.Object({
    id: Type.String({ description: 'Scheduled session ID' }),
  }),
  response: {
    200: ScheduledSessionResponse,
    404: SHARED_ERROR_REPLY_SCHEMA[404],
    500: SHARED_ERROR_REPLY_SCHEMA[500],
  },
};

const GET_SCHEDULED_SESSION_ROUTE: BaseRouteSchema = {
  method: 'GET',
  url: '/api/v1/scheduled-sessions/:id',
};

// ─── LIST ───

const LIST_SCHEDULED_SESSIONS_SCHEMA = {
  description: 'Lists scheduled sessions with optional filters',
  tags: ['Scheduled Sessions'],
  querystring: Type.Object({
    limit: Type.Optional(
      Type.Integer({
        description: 'Maximum number of results',
        minimum: 1,
        maximum: 100,
        default: 20,
      }),
    ),
    offset: Type.Optional(
      Type.Integer({
        description: 'Number of results to skip',
        minimum: 0,
        default: 0,
      }),
    ),
    from: Type.Optional(
      Type.String({
        description:
          'Filter sessions scheduled at or after this ISO 8601 timestamp',
      }),
    ),
    to: Type.Optional(
      Type.String({
        description:
          'Filter sessions scheduled before this ISO 8601 timestamp',
      }),
    ),
  }),
  response: {
    200: Type.Object({
      items: Type.Array(ScheduledSessionResponse),
      total: Type.Integer({ description: 'Total matching results' }),
    }),
    400: SHARED_ERROR_REPLY_SCHEMA[400],
    500: SHARED_ERROR_REPLY_SCHEMA[500],
  },
};

const LIST_SCHEDULED_SESSIONS_ROUTE: BaseRouteSchema = {
  method: 'GET',
  url: '/api/v1/scheduled-sessions',
};

// ─── UPDATE ───

const UPDATE_SCHEDULED_SESSION_SCHEMA = {
  description: 'Updates an existing scheduled session',
  tags: ['Scheduled Sessions'],
  params: Type.Object({
    id: Type.String({ description: 'Scheduled session ID' }),
  }),
  body: Type.Object(
    {
      kioskId: Type.Optional(
        Type.String({
          description: 'ID of the kiosk to reassign to',
        }),
      ),
      title: Type.Optional(
        Type.String({
          description: 'Session title',
          minLength: 1,
          maxLength: 255,
        }),
      ),
      sessionLength: Type.Optional(
        Type.Integer({
          description: 'Session duration in seconds',
          minimum: 60,
          maximum: 86400,
        }),
      ),
      scheduledAt: Type.Optional(
        Type.String({
          description: 'ISO 8601 timestamp for when session should start',
        }),
      ),
      recurrenceRule: Type.Optional(
        Type.Union([Type.String(), Type.Null()], {
          description: 'Recurrence rule or null for one-time sessions',
        }),
      ),
    },
    { description: 'Scheduled session update request (partial)' },
  ),
  response: {
    200: ScheduledSessionResponse,
    400: SHARED_ERROR_REPLY_SCHEMA[400],
    404: SHARED_ERROR_REPLY_SCHEMA[404],
    500: SHARED_ERROR_REPLY_SCHEMA[500],
  },
};

const UPDATE_SCHEDULED_SESSION_ROUTE: BaseRouteSchema = {
  method: 'PATCH',
  url: '/api/v1/scheduled-sessions/:id',
};

// ─── DELETE ───

const DELETE_SCHEDULED_SESSION_SCHEMA = {
  description: 'Deletes a scheduled session',
  tags: ['Scheduled Sessions'],
  params: Type.Object({
    id: Type.String({ description: 'Scheduled session ID' }),
  }),
  response: {
    204: Type.Null({ description: 'Session deleted successfully' }),
    404: SHARED_ERROR_REPLY_SCHEMA[404],
    500: SHARED_ERROR_REPLY_SCHEMA[500],
  },
};

const DELETE_SCHEDULED_SESSION_ROUTE: BaseRouteSchema = {
  method: 'DELETE',
  url: '/api/v1/scheduled-sessions/:id',
};

export {
  CREATE_SCHEDULED_SESSION_SCHEMA,
  CREATE_SCHEDULED_SESSION_ROUTE,
  GET_SCHEDULED_SESSION_SCHEMA,
  GET_SCHEDULED_SESSION_ROUTE,
  LIST_SCHEDULED_SESSIONS_SCHEMA,
  LIST_SCHEDULED_SESSIONS_ROUTE,
  UPDATE_SCHEDULED_SESSION_SCHEMA,
  UPDATE_SCHEDULED_SESSION_ROUTE,
  DELETE_SCHEDULED_SESSION_SCHEMA,
  DELETE_SCHEDULED_SESSION_ROUTE,
};