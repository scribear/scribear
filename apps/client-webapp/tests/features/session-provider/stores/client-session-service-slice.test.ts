import { describe, expect, it } from 'vitest';

import {
  ClientLifecycle,
  JoinNotice,
  SessionConnectionStatus,
} from '#src/features/session-provider/services/client-session-service-status';
import {
  clientSessionServiceReducer,
  setActiveSession,
  setJoinNotice,
  setLifecycle,
  setSessionStatus,
} from '#src/features/session-provider/stores/client-session-service-slice';

describe('clientSessionServiceSlice', () => {
  it('seeds sessionStatus as null, not as an all-false snapshot', () => {
    const state = clientSessionServiceReducer(
      undefined,
      setActiveSession('session-uid'),
    );

    // Seeding {transcriptionServiceConnected: false, sourceDeviceConnected:
    // false} here made "node-server has not reported yet" indistinguishable
    // from "node-server reported a dead upstream", and put a fault banner on
    // screen from the instant of a *successful* join.
    expect(state.session).toEqual({
      sessionUid: 'session-uid',
      connectionStatus: SessionConnectionStatus.CONNECTING,
      sessionStatus: null,
    });
  });

  it('records the first reported sessionStatus', () => {
    const joined = clientSessionServiceReducer(
      undefined,
      setActiveSession('session-uid'),
    );
    const state = clientSessionServiceReducer(
      joined,
      setSessionStatus({
        transcriptionServiceConnected: false,
        sourceDeviceConnected: false,
      }),
    );

    expect(state.session?.sessionStatus).toEqual({
      transcriptionServiceConnected: false,
      sourceDeviceConnected: false,
    });
  });

  it('keeps the join notice across the drop to IDLE that reopens the dialog', () => {
    const ended = clientSessionServiceReducer(
      undefined,
      setJoinNotice(JoinNotice.SESSION_ENDED),
    );
    const state = clientSessionServiceReducer(
      ended,
      setLifecycle(ClientLifecycle.IDLE),
    );

    // `setLifecycle` deliberately drops `session`; if it dropped the notice
    // too, the explanation would die one action before the dialog that has to
    // render it opens.
    expect(state.joinNotice).toBe(JoinNotice.SESSION_ENDED);
    expect(state.session).toBeNull();
  });

  it('starts with no join notice and clears it on setJoinNotice(null)', () => {
    const initial = clientSessionServiceReducer(
      undefined,
      setLifecycle(ClientLifecycle.INITIALIZING),
    );
    expect(initial.joinNotice).toBeNull();

    const ended = clientSessionServiceReducer(
      initial,
      setJoinNotice(JoinNotice.SESSION_ENDED),
    );
    expect(
      clientSessionServiceReducer(ended, setJoinNotice(null)).joinNotice,
    ).toBeNull();
  });

  it('clears the session on setActiveSession(null)', () => {
    const joined = clientSessionServiceReducer(
      undefined,
      setActiveSession('session-uid'),
    );
    expect(
      clientSessionServiceReducer(joined, setActiveSession(null)).session,
    ).toBeNull();
  });
});
