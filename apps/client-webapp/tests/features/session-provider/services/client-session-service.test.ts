import { EventEmitter } from 'eventemitter3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { NodeServerClient } from '@scribear/node-server-client';
import { createNodeServerClient } from '@scribear/node-server-client';
import {
  TranscriptionServiceDisconnectReason,
  TranscriptionStreamServerMessageType,
} from '@scribear/node-server-schema';
import type { SessionManagerClient } from '@scribear/session-manager-client';
import { createSessionManagerClient } from '@scribear/session-manager-client';

import { ClientSessionService } from '#src/features/session-provider/services/client-session-service';
import type { SessionStatusSnapshot } from '#src/features/session-provider/services/client-session-service';

vi.mock('@scribear/node-server-client', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@scribear/node-server-client')>();
  return {
    ...actual,
    createNodeServerClient: vi.fn(),
  };
});

vi.mock('@scribear/session-manager-client', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@scribear/session-manager-client')>();
  return {
    ...actual,
    createSessionManagerClient: vi.fn(),
  };
});

/**
 * Minimal stand-in for `WebSocketClient` - an EventEmitter with the handful
 * of methods `ClientSessionService` calls on it. Real connect/reconnect
 * behavior lives in `@scribear/base-websocket-client` and is out of scope
 * here; this test only exercises how `ClientSessionService` reacts to
 * messages/close codes it receives.
 */
function createFakeSocket() {
  const socket = new EventEmitter();
  return Object.assign(socket, {
    start: vi.fn(),
    send: vi.fn(),
    terminate: vi.fn(),
  });
}

const IDENTITY = {
  sessionUid: 'session-uid',
  sessionRefreshToken: 'refresh-token',
  clientId: 'client-id',
};

describe('ClientSessionService SESSION_STATUS handling', () => {
  let fakeSocket: ReturnType<typeof createFakeSocket>;

  beforeEach(() => {
    fakeSocket = createFakeSocket();
    vi.mocked(createNodeServerClient).mockReturnValue({
      transcriptionStreamClient: vi.fn(() => fakeSocket),
      transcriptionStreamSource: vi.fn(() => createFakeSocket()),
    } as unknown as NodeServerClient);
    vi.mocked(createSessionManagerClient).mockReturnValue({
      sessionAuth: {
        exchangeJoinCode: vi.fn(),
        refreshSessionToken: vi.fn(),
      },
    } as unknown as SessionManagerClient);
  });

  it('passes transcriptionServiceDisconnectReason through when the server includes it', () => {
    const service = new ClientSessionService();
    const statuses: SessionStatusSnapshot[] = [];
    service.on('sessionStatus', (status) => statuses.push(status));

    service.start(IDENTITY);

    fakeSocket.emit('message', {
      type: TranscriptionStreamServerMessageType.SESSION_STATUS,
      transcriptionServiceConnected: false,
      sourceDeviceConnected: true,
      transcriptionServiceDisconnectReason:
        TranscriptionServiceDisconnectReason.AT_CAPACITY,
    });

    expect(statuses).toEqual([
      {
        transcriptionServiceConnected: false,
        sourceDeviceConnected: true,
        transcriptionServiceDisconnectReason:
          TranscriptionServiceDisconnectReason.AT_CAPACITY,
      },
    ]);
  });

  it('leaves transcriptionServiceDisconnectReason undefined when the server omits it', () => {
    const service = new ClientSessionService();
    const statuses: SessionStatusSnapshot[] = [];
    service.on('sessionStatus', (status) => statuses.push(status));

    service.start(IDENTITY);

    fakeSocket.emit('message', {
      type: TranscriptionStreamServerMessageType.SESSION_STATUS,
      transcriptionServiceConnected: true,
      sourceDeviceConnected: true,
    });

    expect(statuses).toEqual([
      {
        transcriptionServiceConnected: true,
        sourceDeviceConnected: true,
      },
    ]);
    expect(statuses[0]).not.toHaveProperty(
      'transcriptionServiceDisconnectReason',
    );
  });
});
