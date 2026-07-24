import { type Mock, beforeEach, describe, expect, vi } from 'vitest';

import { DemoRoomController } from '#src/server/features/demo-room/demo-room.controller.js';

const DEMO_UID = 'deadbeef-0000-4000-8000-000000000001';
const PAST = new Date('2020-01-01T00:00:00.000Z');
const FUTURE = new Date('2999-01-01T00:00:00.000Z');

function activeSession() {
  return {
    uid: DEMO_UID,
    name: 'Demo — Alice in Wonderland',
    // Started long ago, open-ended: always "currently active".
    effectiveStart: PAST,
    effectiveEnd: null,
  };
}

describe('DemoRoomController', (it) => {
  let mockRepo: { db: object; findSessionByUid: Mock };
  let mockAuth: { ensureCurrentJoinCode: Mock };
  let mockSend: Mock;
  let mockCode: Mock;
  let mockRes: { code: Mock };

  function build(enabled: boolean) {
    return new DemoRoomController(
      { enabled, sessionUid: DEMO_UID },
      mockRepo as never,
      mockAuth as never,
    );
  }

  beforeEach(() => {
    mockRepo = { db: {}, findSessionByUid: vi.fn() };
    mockAuth = { ensureCurrentJoinCode: vi.fn() };
    mockSend = vi.fn();
    mockCode = vi.fn().mockReturnValue({ send: mockSend });
    mockRes = { code: mockCode };
  });

  it('reports disabled without touching the DB or minting a code', async () => {
    await build(false).status({} as never, mockRes as never);

    expect(mockRepo.findSessionByUid).not.toHaveBeenCalled();
    expect(mockAuth.ensureCurrentJoinCode).not.toHaveBeenCalled();
    expect(mockCode).toHaveBeenCalledWith(200);
    expect(mockSend).toHaveBeenCalledWith({
      enabled: false,
      sessionUid: DEMO_UID,
      active: false,
      roomName: null,
      joinCode: null,
    });
  });

  it('reports enabled-but-not-running when the session has not been seeded', async () => {
    mockRepo.findSessionByUid.mockResolvedValue(undefined);

    await build(true).status({} as never, mockRes as never);

    expect(mockAuth.ensureCurrentJoinCode).not.toHaveBeenCalled();
    expect(mockSend).toHaveBeenCalledWith({
      enabled: true,
      sessionUid: DEMO_UID,
      active: false,
      roomName: null,
      joinCode: null,
    });
  });

  it('mints and returns a join code for an active seeded session', async () => {
    mockRepo.findSessionByUid.mockResolvedValue(activeSession());
    mockAuth.ensureCurrentJoinCode.mockResolvedValue('ABCD1234');

    await build(true).status({} as never, mockRes as never);

    expect(mockAuth.ensureCurrentJoinCode).toHaveBeenCalledWith(
      DEMO_UID,
      expect.any(Date),
    );
    expect(mockSend).toHaveBeenCalledWith({
      enabled: true,
      sessionUid: DEMO_UID,
      active: true,
      roomName: 'Demo — Alice in Wonderland',
      joinCode: 'ABCD1234',
    });
  });

  it('does not mint a code for a session whose window has ended', async () => {
    mockRepo.findSessionByUid.mockResolvedValue({
      ...activeSession(),
      effectiveEnd: PAST,
    });

    await build(true).status({} as never, mockRes as never);

    expect(mockAuth.ensureCurrentJoinCode).not.toHaveBeenCalled();
    expect(mockSend).toHaveBeenCalledWith({
      enabled: true,
      sessionUid: DEMO_UID,
      active: false,
      roomName: 'Demo — Alice in Wonderland',
      joinCode: null,
    });
  });

  it('treats a not-yet-started session as not active', async () => {
    mockRepo.findSessionByUid.mockResolvedValue({
      ...activeSession(),
      effectiveStart: FUTURE,
      effectiveEnd: null,
    });

    await build(true).status({} as never, mockRes as never);

    expect(mockAuth.ensureCurrentJoinCode).not.toHaveBeenCalled();
    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({ active: false, joinCode: null }),
    );
  });
});
