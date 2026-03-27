import { DeviceSessionEventType } from '@scribear/session-manager-schema';

export interface SessionEvent {
  eventId: number;
  eventType: DeviceSessionEventType;
  sessionId: string;
  timestampUnixMs: number;
}

type SessionEventListener = (event: SessionEvent) => void;

/**
 * In-memory pub/sub for session events per device.
 * Allows long-poll handlers to be woken up when a new session is created.
 * In the future this could be backed by Redis pub/sub.
 */
export class SessionEventBusService {
  private _listeners = new Map<string, Set<SessionEventListener>>();

  addListener(deviceId: string, listener: SessionEventListener): void {
    let set = this._listeners.get(deviceId);
    if (!set) {
      set = new Set();
      this._listeners.set(deviceId, set);
    }
    set.add(listener);
  }

  removeListener(deviceId: string, listener: SessionEventListener): void {
    this._listeners.get(deviceId)?.delete(listener);
  }

  emit(deviceId: string, event: SessionEvent): void {
    for (const listener of this._listeners.get(deviceId) ?? []) {
      listener(event);
    }
  }
}
