export interface NonAutoSession {
  effectiveStart: Date;
  // All non-auto sessions within a materialization window have a known end.
  effectiveEnd: Date;
}

export interface AutoSessionSlot {
  startTime: Date;
  endTime: Date;
  // UID of the auto_session_windows row this slot falls within.
  windowUid: string;
}

/**
 * Computes time slots for auto sessions that fill gaps within the given active
 * windows (i.e. the room's auto-session-enabled periods).
 *
 * For each active window, any sub-interval not covered by a non-auto session
 * that is at least minDurationSeconds long becomes one slot. Windows are
 * assumed non-overlapping (enforced at write time); non-auto sessions are
 * assumed non-overlapping (enforced by the DB exclusion constraint).
 *
 * Sessions currently active (effectiveStart < now) are included so their tails
 * correctly block the start of the first applicable window.
 */
export function materializeAutoSessions(
  nonAutoSessions: NonAutoSession[],
  activeWindows: { uid: string; start: Date; end: Date }[],
  now: Date,
  minDurationSeconds: number,
): AutoSessionSlot[] {
  if (activeWindows.length === 0) return [];

  const horizonMs = Math.max(...activeWindows.map((w) => w.end.getTime()));

  const relevant = nonAutoSessions.filter(
    (s) =>
      s.effectiveEnd.getTime() > now.getTime() &&
      s.effectiveStart.getTime() < horizonMs,
  );

  const blocked = sortIntervals(
    relevant.map((s) => ({
      start: new Date(Math.max(s.effectiveStart.getTime(), now.getTime())),
      end: s.effectiveEnd,
    })),
  );

  const sortedWindows = sortIntervals(activeWindows);
  const slots: AutoSessionSlot[] = [];

  for (const win of sortedWindows) {
    let cursorMs = Math.max(win.start.getTime(), now.getTime());
    const winEndMs = win.end.getTime();

    if (cursorMs >= winEndMs) continue;

    for (const b of blocked) {
      const bStartMs = b.start.getTime();
      const bEndMs = b.end.getTime();

      if (bEndMs <= cursorMs || bStartMs >= winEndMs) continue;

      if (bStartMs > cursorMs) {
        addSlotIfLongEnough(
          slots,
          new Date(cursorMs),
          new Date(Math.min(bStartMs, winEndMs)),
          win.uid,
          minDurationSeconds,
        );
      }

      cursorMs = Math.min(Math.max(cursorMs, bEndMs), winEndMs);
    }

    if (cursorMs < winEndMs) {
      addSlotIfLongEnough(
        slots,
        new Date(cursorMs),
        new Date(winEndMs),
        win.uid,
        minDurationSeconds,
      );
    }
  }

  return slots;
}

function addSlotIfLongEnough(
  slots: AutoSessionSlot[],
  start: Date,
  end: Date,
  windowUid: string,
  minDurationSeconds: number,
): void {
  if ((end.getTime() - start.getTime()) / 1000 >= minDurationSeconds) {
    slots.push({ startTime: start, endTime: end, windowUid });
  }
}

function sortIntervals<T extends { start: Date; end: Date }>(
  intervals: T[],
): T[] {
  return [...intervals].sort((a, b) => a.start.getTime() - b.start.getTime());
}
