import type { Migration, MigrationProvider } from 'kysely';

import * as m00000000EnablePgTrgm from './migrations/00000000-enable-pg-trgm.js';
import * as m00000001Devices from './migrations/00000001-devices.js';
import * as m00000002Rooms from './migrations/00000002-rooms.js';
import * as m00000003RoomDevices from './migrations/00000003-room-devices.js';
import * as m00000004SessionSchedules from './migrations/00000004-session-schedules.js';
import * as m00000005AutoSessionWindows from './migrations/00000005-auto-session-windows.js';
import * as m00000006EnableBtreeGist from './migrations/00000006-enable-btree-gist.js';
import * as m00000007EnablePgCron from './migrations/00000007-enable-pg-cron.js';
import * as m00000008Sessions from './migrations/00000008-sessions.js';
import * as m00000009SessionRefreshTokens from './migrations/00000009-session-refresh-tokens.js';
import * as m00000010SessionJoinCodes from './migrations/00000010-session-join-codes.js';
import * as m00000011DeviceLastSeen from './migrations/00000011-device-last-seen.js';
import * as m00000012SessionsCanceledAt from './migrations/00000012-sessions-canceled-at.js';

/**
 * Every migration, keyed by the name kysely records in `kysely_migration`.
 *
 * **Why this list is written out by hand.** Until this existed, `getMigrator`
 * used kysely's `FileMigrationProvider`, which globs `dist/src/migrations/*.js`
 * at runtime. That works for `npm run migrate:up` from a checkout and nowhere
 * else: every service image ships a single esbuild bundle (`dist/bundle.mjs`)
 * with no loose migration files beside it, so the schema could only ever be
 * applied from a source tree — which is why deployments migrated by cloning the
 * repo into a throwaway container. Static imports bundle, so the same image
 * that runs the app can apply the schema the app was built against.
 * `apps/admin-server/src/db/get-admin-migrator.ts` does this already for its own
 * tables, for the same reason.
 *
 * **The keys must never change.** They are the primary key of
 * `kysely_migration` on every existing database; renaming one makes an applied
 * migration look unapplied and it will be run a second time.
 *
 * A new migration file has to be added here or it is silently never applied.
 * `tests/unit/migration-registry.test.ts` compares this list against the
 * directory to make that a failing test rather than a production surprise.
 */
export const MIGRATIONS: Record<string, Migration> = {
  '00000000-enable-pg-trgm': m00000000EnablePgTrgm,
  '00000001-devices': m00000001Devices,
  '00000002-rooms': m00000002Rooms,
  '00000003-room-devices': m00000003RoomDevices,
  '00000004-session-schedules': m00000004SessionSchedules,
  '00000005-auto-session-windows': m00000005AutoSessionWindows,
  '00000006-enable-btree-gist': m00000006EnableBtreeGist,
  '00000007-enable-pg-cron': m00000007EnablePgCron,
  '00000008-sessions': m00000008Sessions,
  '00000009-session-refresh-tokens': m00000009SessionRefreshTokens,
  '00000010-session-join-codes': m00000010SessionJoinCodes,
  '00000011-device-last-seen': m00000011DeviceLastSeen,
  '00000012-sessions-canceled-at': m00000012SessionsCanceledAt,
};

/**
 * The migrations this build knows about, in the order kysely applies them.
 *
 * Sorted explicitly rather than relying on object key order: this is the
 * "expected schema version" every consumer compares against, and it should not
 * depend on how carefully the record above was typed.
 */
export const MIGRATION_NAMES: readonly string[] = Object.keys(MIGRATIONS).sort(
  (a, b) => a.localeCompare(b),
);

/**
 * The newest migration this build knows about — a one-line schema version, and
 * what the admin console compares between containers to spot mixed image tags.
 */
export const LATEST_MIGRATION: string =
  MIGRATION_NAMES[MIGRATION_NAMES.length - 1] ?? '';

/** Static provider over {@link MIGRATIONS}. See the note there. */
export class StaticMigrationProvider implements MigrationProvider {
  getMigrations(): Promise<Record<string, Migration>> {
    return Promise.resolve(MIGRATIONS);
  }
}
