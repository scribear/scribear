import type {
  DBOrTrx,
  ScheduleManagementRepository,
} from '#src/server/features/schedule-management/schedule-management.repository.js';

import {
  type AutoSessionSlot,
  materializeAutoSessions,
} from './auto-session-materializer.js';
import { buildAutoSessionRow } from './occurrence-to-session.js';
import { materializeWindow } from './window-materializer.js';

/**
 * Brings the room's auto sessions into agreement with its active windows and
 * non-auto sessions over `[now, windowEnd]`. Used by every schedule and
 * window write path.
 *
 * Algorithm:
 * 1. Read forward-active windows; expand each to UTC daily ranges within
 *    the materialization window.
 * 2. Read non-auto sessions whose effective interval overlaps the same range.
 * 3. Run the auto-session-materializer to compute desired slots.
 * 4. Preserve the active auto session row if a slot still covers its start;
 *    otherwise set its `end_override = now`.
 * 5. Delete future auto sessions and re-insert from the (remaining) slots.
 *
 * The exclusion constraint is deferred for the duration of the swap so the
 * delete + re-insert can transiently break non-overlap.
 *
 * `autoSessionEnabled` is the room's master switch. When `false`, the
 * reconciler treats the room as having no active windows: any in-flight
 * AUTO session is ended via `end_override` and no new ones are produced.
 * Windows themselves are not deleted, so flipping the switch back to `true`
 * resumes normal materialization on the next reconcile.
 *
 * @param sessionBumps Output collector. Any session whose `session_config_version`
 *   was bumped during reconciliation is recorded here as `uid -> newVersion`
 *   so the caller can publish events after the transaction commits.
 */
export async function reconcileAutoSessions(
  db: DBOrTrx,
  repo: ScheduleManagementRepository,
  roomUid: string,
  timezone: string,
  now: Date,
  windowEnd: Date,
  minAutoDurationSeconds: number,
  autoSessionEnabled: boolean,
  sessionBumps: Map<string, number>,
): Promise<void> {
  const windows = autoSessionEnabled
    ? await repo.findWindowsOverlapping(db, roomUid, {
        from: now,
        to: windowEnd,
      })
    : [];

  const expandedWindows: { uid: string; start: Date; end: Date }[] = [];
  for (const w of windows) {
    const occs = materializeWindow(w, timezone, now, windowEnd);
    for (const o of occs) {
      expandedWindows.push({
        uid: o.windowUid,
        start: o.startUtc,
        end: o.endUtc,
      });
    }
  }

  const nonAuto = await repo.findNonAutoSessionsInRange(db, roomUid, {
    from: now,
    to: windowEnd,
  });

  const slots = materializeAutoSessions(
    nonAuto.map((s) => ({
      effectiveStart: s.effectiveStart,
      // Open-ended on-demand sessions block any auto session beyond `now` —
      // model that as a session that ends at the materialization horizon.
      effectiveEnd: s.effectiveEnd ?? windowEnd,
    })),
    expandedWindows,
    now,
    minAutoDurationSeconds,
  );

  const active = await repo.findActiveAutoSession(db, roomUid, now);

  await repo.setSessionsConstraintsDeferred(db);
  await repo.deleteUpcomingAutoSessions(db, roomUid, now);

  let preservedSlot: AutoSessionSlot | null = null;
  if (active) {
    const slot = slots.find(
      (s) =>
        s.startTime.getTime() <= active.effectiveStart.getTime() &&
        s.endTime.getTime() > active.effectiveStart.getTime(),
    );
    if (slot) {
      // Preserve the active row in place; update its end if the slot has shifted.
      const currentEnd = active.effectiveEnd?.getTime() ?? null;
      if (currentEnd !== slot.endTime.getTime()) {
        const newVersion = await repo.updateSessionScheduledEnd(
          db,
          active.uid,
          slot.endTime,
        );
        sessionBumps.set(active.uid, newVersion);
      }
      preservedSlot = slot;
    } else {
      // No covering slot: end the active auto session cleanly.
      const newVersion = await repo.updateSessionEndOverride(
        db,
        active.uid,
        now,
      );
      sessionBumps.set(active.uid, newVersion);
    }
  }

  const winById = new Map(windows.map((w) => [w.uid, w]));
  const rows = slots
    .filter((s) => s !== preservedSlot)
    .map((s) => {
      const win = winById.get(s.windowUid);
      if (!win) {
        // Materializer should never produce a slot with an unknown window uid.
        throw new Error(
          `auto-session reconciler: slot references unknown window ${s.windowUid}`,
        );
      }
      return buildAutoSessionRow(s, win);
    });

  await repo.insertSessions(db, rows);
}
