import type { TSchema } from 'typebox';

type SecurityRequirement = Record<string, string[]>[];

interface BaseWebSocketRouteSchema {
  description: string;
  tags: string[];
  querystring?: TSchema;
  params?: TSchema;
  headers?: TSchema;
  security?: SecurityRequirement;
  hide?: boolean;
  allowClientBinaryMessage: boolean;
  clientMessage?: TSchema;
  allowServerBinaryMessage: boolean;
  serverMessage?: TSchema;
}

export type { BaseWebSocketRouteSchema };
