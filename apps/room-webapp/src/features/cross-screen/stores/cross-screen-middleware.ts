import type { Middleware } from '@reduxjs/toolkit';

import { createNodeServerClient } from '@scribear/node-server-client';
import {
  SessionClientClientMessageType,
  SessionClientServerMessageType,
} from '@scribear/node-server-schema';
import { createSessionManagerClient } from '@scribear/session-manager-client';
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
const isTouchscreenTab = () => window.location.pathname.startsWith('/touchscreen');

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
        switch (message.type) {
          case BroadcastMessageType.SETTINGS_UPDATE:
            store.dispatch(setFontSize(message.payload.fontSize));
            store.dispatch(setShowJoinCode(message.payload.showJoinCode));
            break;
          case BroadcastMessageType.AUTH_STATE_CHANGE:
            store.dispatch(setDeviceName(message.payload.deviceName));
            store.dispatch(setDeviceId(message.payload.deviceId));
            break;
          case BroadcastMessageType.SESSION_STATE_CHANGE: {
            const { activeSessionId, joinCode, joinCodeExpiresAtUnixMs, upcomingSessions } =
              message.payload;
            store.dispatch(setActiveSessionId(activeSessionId));
            store.dispatch(
              setJoinCode(
                joinCode !== null && joinCodeExpiresAtUnixMs !== null
                  ? { joinCode, expiresAtUnixMs: joinCodeExpiresAtUnixMs }
                  : null,
              ),
            );
            store.dispatch(setUpcomingSessions(upcomingSessions));

            if (activeSessionId) {
              void connectDisplaySession(activeSessionId);
            } else {
              disconnectDisplaySession();
            }
            break;
          }
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

      if (isTouchscreenTab()) {
        const state = store.getState();

        if (setFontSize.match(action) || setShowJoinCode.match(action)) {
          broadcastService.send({
            type: BroadcastMessageType.SETTINGS_UPDATE,
            payload: {
              fontSize: state.displaySettings.fontSize,
              showJoinCode: state.displaySettings.showJoinCode,
            },
          });
        }

        if (setDeviceName.match(action) || setDeviceId.match(action)) {
          broadcastService.send({
            type: BroadcastMessageType.AUTH_STATE_CHANGE,
            payload: {
              isActivated: state.roomConfig.deviceName !== null,
              deviceName: state.roomConfig.deviceName,
              deviceId: state.roomConfig.deviceId,
            },
          });
        }

        if (
          setActiveSessionId.match(action) ||
          setJoinCode.match(action) ||
          setUpcomingSessions.match(action)
        ) {
          broadcastService.send({
            type: BroadcastMessageType.SESSION_STATE_CHANGE,
            payload: {
              activeSessionId: state.roomConfig.activeSessionId,
              joinCode: state.roomService.joinCode,
              joinCodeExpiresAtUnixMs: state.roomService.joinCodeExpiresAtUnixMs,
              upcomingSessions: state.roomService.upcomingSessions,
            },
          });
        }
      }

      return result;
    };
  };
