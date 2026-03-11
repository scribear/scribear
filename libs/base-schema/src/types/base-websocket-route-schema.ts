import type { TSchema } from 'typebox';

type SecurityRequirement = Record<string, string[]>[];

type WsCloseCode =
  | 1000
  | 1001
  | 1002
  | 1003
  | 1005
  | 1006
  | 1007
  | 1008
  | 1009
  | 1010
  | 1011
  | 1012
  | 1013
  | 1015
  | (number & {});

interface BaseWebSocketRouteSchema {
  description: string;
  tags: string[];
  querystring?: TSchema;
  params?: TSchema;
  headers?: TSchema;
  security?: SecurityRequirement;
  hide?: boolean;
  allowClientBinaryMessage: boolean;
  clientMessage: TSchema;
  allowServerBinaryMessage: boolean;
  serverMessage: TSchema;
  closeCodes: Partial<Record<WsCloseCode, { description: string }>>;
}

export type { BaseWebSocketRouteSchema, WsCloseCode };
