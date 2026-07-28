/**
 * The timezone the browser is running in, e.g. `America/Chicago`. Falls back
 * to `UTC` on the rare engine that reports no zone.
 */
export function browserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

/**
 * Formats an ISO instant in an explicit timezone.
 *
 * Every admin page that prints a timestamp goes through this, so a page can
 * state which zone it is using (see `TimezoneNote`) and be telling the truth.
 * Falls back to the browser's own formatting if the zone is one `Intl` will
 * not accept — a bad `rooms.timezone` should degrade to a readable time, not
 * throw and blank the table that called it.
 */
export function formatInTimeZone(iso: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone,
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(iso));
  } catch {
    return new Date(iso).toLocaleString();
  }
}
