import type { Middleware, UnknownAction } from '@reduxjs/toolkit';

import { createNodeServerClient } from '@scribear/node-server-client';
import {
  SessionClientClientMessageType,
  SessionClientServerMessageType,
} from '@scribear/node-server-schema';
import { createSessionManagerClient } from '@scribear/session-manager-client';
import {
  appInitialization,
  rememberRehydrated,
} from '@scribear/redux-remember-store';
import { handleTranscript } from '@scribear/transcription-content-store';

import {
  setActiveSessionId,
  setDeviceId,
  setDeviceName,
} from '#src/features/room-provider/stores/room-config-slice';
import {
  setJoinCode,
  setUpcomingSessions,
} from '#src/features/room-provider/stores/room-service-slice';
import type { RootState } from '#src/store/store';

import {
  BroadcastChannelService,
  BroadcastMessageType,
} from '../services/broadcast-channel-service';
import { setFontSize, setShowJoinCode } from './display-settings-slice';

const isDisplayTab = () => window.location.pathname.startsWith('/display');
const isTouchscreenTab = () =>
  window.location.pathname.startsWith('/touchscreen');

// Action types that are mirrored 1:1 from the touchscreen tab to the display
// tab via BroadcastChannel. Both tabs run identical reducers, so dispatching
// the same action object in the display store produces the same state mutation
// without a separate translation layer.
const MIRRORED_ACTION_TYPES: ReadonlySet<string> = new Set<string>([
  setFontSize.type,
  setShowJoinCode.type,
  setDeviceName.type,
  setDeviceId.type,
  setActiveSessionId.type,
  setJoinCode.type,
  setUpcomingSessions.type,
]);

const isMirroredAction = (action: unknown): action is UnknownAction =>
  action !== null &&
  typeof action === 'object' &&
  typeof (action as { type?: unknown }).type === 'string' &&
  MIRRORED_ACTION_TYPES.has((action as UnknownAction).type);

export const createCrossScreenMiddleware =
  (): Middleware<object, RootState> =>
  (store) => {
    const broadcastService = new BroadcastChannelService();

    let unsubscribeMessages: (() => void) | null = null;

    // Track the display tab's session client connection
    let currentSessionClientSocket: { close: (code?: number, reason?: string) => void } | null =
      null;
    let currentDisplaySessionId: string | null = null;

    const sessionManagerClient = createSessionManagerClient(window.location.origin);
    const nodeServerClient = createNodeServerClient(window.location.origin);

    // Build the actions that recreate the cross-screen state in the receiving
    // tab. Used both on touchscreen init (push) and in response to the display
    // tab's REQUEST_SNAPSHOT (pull). Each action is mirrored individually so
    // the display store applies them through its normal reducer paths.
    const buildSnapshotActions = (state: RootState): UnknownAction[] => [
      setFontSize(state.displaySettings.fontSize),
      setShowJoinCode(state.displaySettings.showJoinCode),
      setDeviceName(state.roomConfig.deviceName),
      setDeviceId(state.roomConfig.deviceId),
      setActiveSessionId(state.roomConfig.activeSessionId),
      setJoinCode(
        state.roomService.joinCode !== null &&
          state.roomService.joinCodeExpiresAtUnixMs !== null
          ? {
              joinCode: state.roomService.joinCode,
              expiresAtUnixMs: state.roomService.joinCodeExpiresAtUnixMs,
            }
          : null,
      ),
      setUpcomingSessions(state.roomService.upcomingSessions),
    ];

    const sendSnapshot = () => {
      for (const action of buildSnapshotActions(store.getState())) {
        broadcastService.send({
          type: BroadcastMessageType.MIRROR_ACTION,
          action,
        });
      }
    };

    const connectDisplaySession = async (sessionId: string) => {
      if (currentDisplaySessionId === sessionId) return;

      currentSessionClientSocket?.close(1000);
      currentSessionClientSocket = null;
      currentDisplaySessionId = sessionId;

      const [authResponse, authError] = await sessionManagerClient.sourceDeviceSessionAuth({
        body: { sessionId },
      });

      if (authError || authResponse.status !== 200 || currentDisplaySessionId !== sessionId) return;

      const { sessionToken } = authResponse.data;

      const [socket, connectError] = await nodeServerClient.sessionClient({
        params: { sessionId },
      });

      if (connectError || currentDisplaySessionId !== sessionId) {
        socket?.close(1000);
        return;
      }

      currentSessionClientSocket = socket;

      socket.send({ type: SessionClientClientMessageType.AUTH, sessionToken });

      socket.on('message', (message) => {
        if (message.type === SessionClientServerMessageType.TRANSCRIPT) {
          store.dispatch(
            handleTranscript({
              final: message.final,
              inProgress: message.in_progress,
            }),
          );
        }
      });

      socket.on('close', () => {
        if (currentDisplaySessionId === sessionId) {
          currentSessionClientSocket = null;
          currentDisplaySessionId = null;
        }
      });
    };

    const disconnectDisplaySession = () => {
      currentSessionClientSocket?.close(1000);
      currentSessionClientSocket = null;
      currentDisplaySessionId = null;
    };

    if (isDisplayTab()) {
      unsubscribeMessages = broadcastService.onMessage((message) => {
        if (message.type === BroadcastMessageType.MIRROR_ACTION) {
          store.dispatch(message.action);
        }
      });

      // Catch-up path for late-opening display tabs: ask the touchscreen for
      // its current state. The touchscreen's own appInitialization snapshot
      // covers the case where both tabs reload together; this covers the case
      // where the touchscreen has been running for a while.
      // Defer so the Redux store is fully constructed before the touchscreen
      // reply dispatches into this store (Redux 5+ forbids dispatch during
      // middleware setup / initial dispatch chain).
      queueMicrotask(() => {
        broadcastService.send({ type: BroadcastMessageType.REQUEST_SNAPSHOT });
      });
    }

    if (isTouchscreenTab()) {
      unsubscribeMessages = broadcastService.onMessage((message) => {
        if (message.type === BroadcastMessageType.REQUEST_SNAPSHOT) {
          sendSnapshot();
        }
      });
    }

    if (import.meta.hot) {
      import.meta.hot.dispose(() => {
        disconnectDisplaySession();
        unsubscribeMessages?.();
        broadcastService.close();
      });
    }

    return (next) => (action) => {
      const result = next(action);

      if (isDisplayTab()) {
        if (
          appInitialization.match(action) ||
          rememberRehydrated.match(action) ||
          setActiveSessionId.match(action)
        ) {
          const { activeSessionId } = store.getState().roomConfig;
          if (activeSessionId) {
            void connectDisplaySession(activeSessionId);
          } else {
            disconnectDisplaySession();
          }
        }
      }

      if (isTouchscreenTab()) {
        if (appInitialization.match(action) || rememberRehydrated.match(action)) {
          sendSnapshot();
        }

        if (isMirroredAction(action)) {
          broadcastService.send({
            type: BroadcastMessageType.MIRROR_ACTION,
            action,
          });
        }
      }

      return result;
    };
  };
