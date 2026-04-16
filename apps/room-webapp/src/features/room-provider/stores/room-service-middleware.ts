import { type Middleware } from '@reduxjs/toolkit';

import type { MicrophoneService } from '@scribear/microphone-store';
import {
  appInitialization,
  rememberRehydrated,
} from '@scribear/redux-remember-store';
import { handleTranscript } from '@scribear/transcription-content-store';

import type { RootState } from '#src/store/store';

import { RoomService } from '../services/room-service';
import {
  selectActiveSessionId,
  selectDeviceName,
  selectPrevEventId,
  selectSessionRefreshToken,
  setActiveSessionId,
  setDeviceId,
  setDeviceName,
  setPrevEventId,
  setSessionRefreshToken,
} from './room-config-slice';
import {
  muteToggle,
  registerDevice,
  selectIsMuted,
  setIsMuted,
  setJoinCode,
  setRoomServiceStatus,
  setSessionStatus,
  setUpcomingSessions,
} from './room-service-slice';

// Module-level reference for HMR cleanup.
let _activeRoomService: RoomService | null = null;

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    _activeRoomService?.removeAllListeners();
    _activeRoomService?.deactivate();
    _activeRoomService = null;
  });
}

/**
 * Redux middleware that manages the `RoomService` lifecycle in response to
 * store actions. Creates the service, wires up event listeners that dispatch
 * transcription and state actions, activates on initialization and rehydration,
 * and handles mute toggling via `muteToggle` actions dispatched by the UI.
 */
export const createRoomServiceMiddleware =
  (microphoneService: MicrophoneService): Middleware<object, RootState> =>
  (store) => {
    // Clean up any previous instance (handles HMR module replacement).
    _activeRoomService?.removeAllListeners();
    _activeRoomService?.deactivate();

    const roomService = new RoomService(microphoneService);
    _activeRoomService = roomService;

    roomService.on('statusChange', (status) => {
      store.dispatch(setRoomServiceStatus(status));
    });
    roomService.on('transcript', (event) => {
      store.dispatch(handleTranscript(event));
    });
    roomService.on('sessionStarted', (sessionId) => {
      store.dispatch(setActiveSessionId(sessionId));
    });
    roomService.on('sessionEnded', () => {
      store.dispatch(setActiveSessionId(null));
      store.dispatch(setSessionStatus(null));
      store.dispatch(setIsMuted(false));
    });
    roomService.on('sessionStatus', (status) => {
      store.dispatch(setSessionStatus(status));
    });
    roomService.on('deviceRegistered', (deviceName, deviceId) => {
      store.dispatch(setDeviceName(deviceName));
      store.dispatch(setDeviceId(deviceId));
    });
    roomService.on('deviceUnregistered', () => {
      store.dispatch(setDeviceName(null));
      store.dispatch(setDeviceId(null));
    });
    roomService.on('prevEventIdUpdated', (eventId) => {
      store.dispatch(setPrevEventId(eventId));
    });
    roomService.on('sessionRefreshTokenUpdated', (token) => {
      store.dispatch(setSessionRefreshToken(token));
    });
    roomService.on('joinCodeUpdated', (data) => {
      store.dispatch(setJoinCode(data));
    });
    roomService.on('upcomingSessionsUpdated', (sessions) => {
      store.dispatch(setUpcomingSessions(sessions));
    });

    return (next) => (action) => {
      const result = next(action);

      if (appInitialization.match(action) || rememberRehydrated.match(action)) {
        const state = store.getState();
        roomService.activate(
          selectDeviceName(state),
          selectActiveSessionId(state),
          selectPrevEventId(state),
          selectSessionRefreshToken(state),
        );
      }

      if (registerDevice.match(action)) {
        void roomService.registerDevice(action.payload);
      }

      if (muteToggle.match(action)) {
        const state = store.getState();
        const sessionId = selectActiveSessionId(state);
        if (sessionId) {
          const previousMuted = selectIsMuted(state);
          store.dispatch(setIsMuted(action.payload));
          void roomService.muteSession(sessionId, action.payload).catch(() => {
            store.dispatch(setIsMuted(previousMuted));
          });
        }
      }

      return result;
    };
  };
