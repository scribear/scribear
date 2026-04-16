import type { Middleware } from '@reduxjs/toolkit';

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
            break;
          }
        }
      });
    }

    if (import.meta.hot) {
      import.meta.hot.dispose(() => {
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
