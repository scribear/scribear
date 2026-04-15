import { type Middleware } from '@reduxjs/toolkit';

import { replaceTranscriptionMirror } from '@scribear/transcription-content-store';

import type { RootState } from '#src/store/store';

import {
  setActiveSessionId,
  setDeviceName,
} from '#src/features/kiosk-provider/stores/kiosk-config-slice';
import {
  setJoinCode,
  setKioskServiceStatus,
  setSessionStatus,
} from '#src/features/kiosk-provider/stores/kiosk-service-slice';
import { setPaused } from '#src/features/session-controls/stores/session-controls-slice';

import {
  type HostSnapshot,
  BroadcastChannelSyncService,
} from '../services/broadcast-channel-sync-service';

interface MiddlewareOptions {
  role: 'host' | 'display';
}

let activeService: BroadcastChannelSyncService | null = null;
let unsubscribe: (() => void) | null = null;

export const createBroadcastChannelMiddleware =
  ({ role }: MiddlewareOptions): Middleware<object, RootState> =>
  (store) => {
    activeService?.close();
    unsubscribe?.();
    const service = new BroadcastChannelSyncService();
    activeService = service;

    if (role === 'display') {
      unsubscribe = service.onSnapshot((snapshot: HostSnapshot) => {
        store.dispatch(setDeviceName(snapshot.deviceName));
        store.dispatch(setActiveSessionId(snapshot.activeSessionId));
        store.dispatch(
          setJoinCode(
            snapshot.joinCode
              ? {
                  joinCode: snapshot.joinCode,
                  expiresAtUnixMs: snapshot.joinCodeExpiresAtUnixMs ?? Date.now(),
                }
              : null,
          ),
        );
        store.dispatch(setKioskServiceStatus(snapshot.kioskServiceStatus as never));
        store.dispatch(setSessionStatus(snapshot.sessionStatus));
        store.dispatch(setPaused(snapshot.isPaused));
        store.dispatch(replaceTranscriptionMirror(snapshot.transcription));
      });
    }

    return (next) => (action) => {
      const result = next(action);
      if (role === 'host') {
        const state = store.getState();
        service.publishSnapshot({
          deviceName: state.kioskConfig.deviceName,
          activeSessionId: state.kioskConfig.activeSessionId,
          joinCode: state.kioskService.joinCode,
          joinCodeExpiresAtUnixMs: state.kioskService.joinCodeExpiresAtUnixMs,
          kioskServiceStatus: state.kioskService.kioskServiceStatus,
          sessionStatus: state.kioskService.sessionStatus,
          isPaused: state.sessionControls.isPaused,
          transcription: {
            commitedSections: state.transcriptionContent.commitedSections,
            activeSection: state.transcriptionContent.activeSection,
            finalizedTranscription: state.transcriptionContent.finalizedTranscription,
            inProgressTranscription: state.transcriptionContent.inProgressTranscription,
          },
        });
      }
      return result;
    };
  };
