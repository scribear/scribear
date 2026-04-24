/** Shared time formatting for wall-panel schedule + clock surfaces. */

export function formatTimeTwoDigit(ms: number): string {
  return new Date(ms).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatTimeNumeric(ms: number): string {
  return new Date(ms).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function formatDateLong(ms: number): string {
  return new Date(ms).toLocaleDateString([], {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });
}

export function minutesUntil(startMs: number, now: number): number {
  return Math.round((startMs - now) / 60_000);
}
