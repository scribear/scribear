---
'@scribear/admin-webapp': patch
---

Register/re-register device dialogs now show a full, clickable kiosk URL with
its own copy button, instead of a bare `/kiosk` path.

- **Built from the page's own origin.** `On the kiosk browser, open /kiosk and
  enter this code.` becomes a real link to
  `${window.location.origin}/kiosk` — read from the browser at render time,
  never a hardcoded scheme/port and never anything sourced from config. The
  admin console and the kiosk are served from the same reverse-proxy origin,
  so this is correct by construction in every deployment (a non-default port,
  plain HTTP on a local network, whatever the operator is actually looking
  at). The link opens in a new tab (`target="_blank"`, with a visually-hidden
  "(opens in a new tab)" suffix so its accessible name says so, matching the
  existing `OpensInNewTab` convention used elsewhere in the console).
- **A second copy button, unambiguously for the URL.** The activation code
  already has its own "Copy activation code" button
  (`ActivationCodeDisplay`); the new "Copy kiosk URL" button sits next to the
  link and copies that instead, so the operator can hand either value to
  whoever is at the kiosk without retyping it. `Copied`/confirmation reaches a
  screen reader through the existing toast (`useToast()`, an assertive
  `role="alert"` Snackbar), not only the eye.
- **Degrades when `navigator.clipboard` doesn't exist.** The Clipboard API
  requires a secure context, and this console is reachable over plain HTTP in
  local deployments — calling `.writeText` on a missing API would throw
  outright. Both that case and an actual write rejection now show a toast
  telling the operator to select the link and copy it by hand; the link text
  itself is always plain, selectable DOM, so nothing is lost either way.
- Fixed in both places the copy appears: `RegisterDeviceDialog`
  (`devices-list-page.tsx`) and `ReregisterResultDialog`
  (`device-detail-page.tsx`), sharing one `KioskUrlInstructions` component so
  the two can't drift.
