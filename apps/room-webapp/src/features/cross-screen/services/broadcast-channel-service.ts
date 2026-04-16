import type { UpcomingSession } from '#src/features/room-provider/stores/room-service-slice';

export enum BroadcastMessageType {
  SETTINGS_UPDATE = 'SETTINGS_UPDATE',
  AUTH_STATE_CHANGE = 'AUTH_STATE_CHANGE',
  SESSION_STATE_CHANGE = 'SESSION_STATE_CHANGE',
}

export interface SettingsUpdatePayload {
  fontSize: number;
  showJoinCode: boolean;
}

export interface AuthStateChangePayload {
  isActivated: boolean;
  deviceName: string | null;
  deviceId: string | null;
}

export interface SessionStateChangePayload {
  activeSessionId: string | null;
  joinCode: string | null;
  joinCodeExpiresAtUnixMs: number | null;
  upcomingSessions: UpcomingSession[];
}

export type BroadcastMessage =
  | { type: BroadcastMessageType.SETTINGS_UPDATE; payload: SettingsUpdatePayload }
  | { type: BroadcastMessageType.AUTH_STATE_CHANGE; payload: AuthStateChangePayload }
  | { type: BroadcastMessageType.SESSION_STATE_CHANGE; payload: SessionStateChangePayload };

const VALID_MESSAGE_TYPES = new Set<string>(Object.values(BroadcastMessageType));

function isBroadcastMessage(data: unknown): data is BroadcastMessage {
  return (
    data !== null &&
    typeof data === 'object' &&
    'type' in data &&
    typeof (data as Record<string, unknown>).type === 'string' &&
    VALID_MESSAGE_TYPES.has((data as Record<string, unknown>).type as string)
  );
}

export class BroadcastChannelService {
  private _channel: BroadcastChannel;

  constructor() {
    this._channel = new BroadcastChannel('scribear-room-display');
  }

  send(message: BroadcastMessage): void {
    this._channel.postMessage(message);
  }

  onMessage(handler: (message: BroadcastMessage) => void): () => void {
    const listener = (event: MessageEvent) => {
      if (isBroadcastMessage(event.data)) {
        handler(event.data);
      }
    };
    this._channel.addEventListener('message', listener);
    return () => this._channel.removeEventListener('message', listener);
  }

  close(): void {
    this._channel.close();
  }
}
