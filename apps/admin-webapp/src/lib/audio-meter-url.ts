/**
 * The standalone audio meter page (A4), copied into the admin-webapp bundle by
 * the `copy-audio-meter-page` Vite plugin and served as a real file by the
 * admin-webapp nginx container (its `try_files $uri` matches before the SPA
 * fallback).
 *
 * Built from `import.meta.env.BASE_URL` — the same source the router's basename
 * uses (`app-provider.tsx`) — rather than a bare `'audio-meter.html'`. A
 * relative href resolves against the *current* path, so from a nested route
 * like `/admin/sessions/:uid` it would resolve to
 * `/admin/sessions/audio-meter.html`; nginx's SPA fallback then serves
 * `index.html`, the router's catch-all redirects to `/`, and the new tab
 * silently shows the dashboard instead of the meter. Root-relative is the only
 * spelling that works from every route.
 */
export function audioMeterHref(): string {
  return `${import.meta.env.BASE_URL.replace(/\/?$/, '/')}audio-meter.html`;
}

/**
 * The same page as an absolute URL, for the copy-to-clipboard affordance: the
 * operator diagnosing a room usually is not sitting at that room's PC and needs
 * to send the link to whoever is, so a path alone is not enough.
 */
export function audioMeterAbsoluteUrl(): string {
  return new URL(audioMeterHref(), window.location.origin).href;
}

/**
 * Shown wherever the meter is linked. The tool measures the *local* microphone
 * of whatever machine opens it, so its value is at the source machine, not the
 * operator's laptop — say so, or the readout gets misread as "the room's audio"
 * (PLAN-AUDIOVIZ §4.2).
 */
export const AUDIO_METER_COPY =
  'Opens a self-contained meter that measures the microphone of the device you open it on — run it on the room’s source machine, not here.';
