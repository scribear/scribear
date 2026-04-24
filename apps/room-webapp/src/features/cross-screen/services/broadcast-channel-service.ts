import type { UnknownAction } from '@reduxjs/toolkit';

export enum BroadcastMessageType {
  /**
   * A Redux action mirrored from the touchscreen tab to the display tab.
   * The receiving tab dispatches `action` verbatim into its own store.
   */
  MIRROR_ACTION = 'MIRROR_ACTION',
  /**
   * Sent by the display tab on connect to ask the touchscreen tab to push its
   * current cross-screen state. The touchscreen responds with a series of
   * MIRROR_ACTION messages that recreate that state in the display store.
   */
  REQUEST_SNAPSHOT = 'REQUEST_SNAPSHOT',
}

export type BroadcastMessage =
  | { type: BroadcastMessageType.MIRROR_ACTION; action: UnknownAction }
  | { type: BroadcastMessageType.REQUEST_SNAPSHOT };

const VALID_MESSAGE_TYPES = new Set<string>(Object.values(BroadcastMessageType));

function isBroadcastMessage(data: unknown): data is BroadcastMessage {
  if (data === null || typeof data !== 'object') return false;
  const record = data as Record<string, unknown>;
  const type = record['type'];
  if (typeof type !== 'string' || !VALID_MESSAGE_TYPES.has(type)) {
    return false;
  }
  if (type === (BroadcastMessageType.MIRROR_ACTION as string)) {
    const action = record['action'] as Record<string, unknown> | null | undefined;
    return (
      action !== null &&
      typeof action === 'object' &&
      typeof action['type'] === 'string'
    );
  }
  return true;
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
    return () => {
      this._channel.removeEventListener('message', listener);
    };
  }

  close(): void {
    this._channel.close();
  }
}
