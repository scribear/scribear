import type {
  DBOrTrx,
  ScheduleManagementRepository,
} from '#src/server/features/schedule-management/schedule-management.repository.js';

import { materializeAutoSessions } from './auto-session-materializer.js';
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

  const blockerSessions = nonAuto.map((s) => ({
    effectiveStart: s.effectiveStart,
    // Open-ended on-demand sessions block any auto session beyond `now` -
    // model that as a session that ends at the materialization horizon.
    effectiveEnd: s.effectiveEnd ?? windowEnd,
  }));

  const active = await repo.findActiveAutoSession(db, roomUid, now);

  // Decide whether the active AUTO can be preserved. The "preserve" branch
  // looks at expanded window ranges (unclipped) rather than materializer
  // slots (clipped to `now`) - active AUTOs typically have
  // `effectiveStart < now`, so a clipped slot can never start at or before
  // `effectiveStart` and the slot-based check would always fall through to
  // `end_override`, interrupting the running AUTO on every reconcile.
  let preservedActive: {
    uid: string;
    effectiveStart: Date;
    newEnd: Date;
  } | null = null;
  if (active) {
    const coveringWin = expandedWindows.find(
      (w) =>
        w.start.getTime() <= active.effectiveStart.getTime() &&
        w.end.getTime() > active.effectiveStart.getTime(),
    );
    if (coveringWin) {
      // The new end is the natural extent of the covering window, bounded
      // by the earliest non-auto session that begins after the active AUTO
      // started (within the same window range).
      const blocker = blockerSessions
        .filter(
          (s) =>
            s.effectiveStart.getTime() > active.effectiveStart.getTime() &&
            s.effectiveStart.getTime() < coveringWin.end.getTime(),
        )
        .sort(
          (a, b) => a.effectiveStart.getTime() - b.effectiveStart.getTime(),
        )[0];
      const newEndMs = blocker
        ? Math.min(coveringWin.end.getTime(), blocker.effectiveStart.getTime())
        : coveringWin.end.getTime();
      preservedActive = {
        uid: active.uid,
        effectiveStart: active.effectiveStart,
        newEnd: new Date(newEndMs),
      };
    }
  }

  // Add the preserved AUTO to the materializer's blocker set so its range
  // is excluded from new slot generation.
  const materializerBlockers = preservedActive
    ? [
        ...blockerSessions,
        {
          effectiveStart: preservedActive.effectiveStart,
          effectiveEnd: preservedActive.newEnd,
        },
      ]
    : blockerSessions;

  const slots = materializeAutoSessions(
    materializerBlockers,
    expandedWindows,
    now,
    minAutoDurationSeconds,
  );

  await repo.setSessionsConstraintsDeferred(db);
  await repo.deleteUpcomingAutoSessions(db, roomUid, now);

  if (active && preservedActive) {
    const currentEnd = active.effectiveEnd?.getTime() ?? null;
    if (currentEnd !== preservedActive.newEnd.getTime()) {
      const newVersion = await repo.updateSessionScheduledEnd(
        db,
        preservedActive.uid,
        preservedActive.newEnd,
      );
      sessionBumps.set(preservedActive.uid, newVersion);
    }
  } else if (active) {
    // No covering window: end the active auto session cleanly.
    const newVersion = await repo.updateSessionEndOverride(db, active.uid, now);
    sessionBumps.set(active.uid, newVersion);
  }

  const winById = new Map(windows.map((w) => [w.uid, w]));
  const rows = slots.map((s) => {
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
