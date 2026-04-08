import { Type } from 'typebox';

export enum SessionChannelEventType {
  SESSION_END = 'SESSION_END',
}

/**
 * Channel definition for session lifecycle events published via Redis pub/sub.
 * Used by session manager (publisher) and node server (subscriber).
 */
export const SESSION_EVENT_CHANNEL = {
  schema: Type.Union([
    Type.Object({
      type: Type.Literal(SessionChannelEventType.SESSION_END),
      endTimeUnixMs: Type.Number(),
    }),
  ]),
  key: (sessionId: string) => `session:${sessionId}`,
};

export type SessionEvent = Type.Static<typeof SESSION_EVENT_CHANNEL.schema>;
