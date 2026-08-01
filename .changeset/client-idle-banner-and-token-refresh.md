---
'@scribear/client-webapp': minor
'@scribear/core-ui': minor
---

The viewer stops reporting a healthy room as broken, and stops hammering
session-manager when it cannot refresh a token.

**The idle room is not a fault.** Immediately after a successful join to a real
room with nobody streaming yet, the Node Server correctly reports
`{transcriptionServiceConnected: false, sourceDeviceConnected: false}` — it only
dials the Transcription Service once a source registers. `deriveConnectionBanner`
rendered that as a warning, _"Connection to the transcription service was lost.
Reconnecting…"_, which never cleared. Every real room looked broken; only the
hardcoded demo room, whose synthetic status hardcodes both flags true, looked
healthy.

- The slice seeded `sessionStatus` with an all-`false` snapshot, which made the
  banner's `sessionStatus === null` escape hatch dead code and put the warning
  up from the instant of a _successful_ join. It is now seeded `null`, so "not
  yet reported" is distinguishable from "reported bad".
- The banner branches on `sourceDeviceConnected` first: no source is the normal
  idle state of a healthy room, so it is informational — _"Waiting for the
  room's microphone to connect."_ — and deliberately never says "reconnecting".
  Only a down upstream _while a source is connected_ is a fault.
- `ConnectionStatusSeverity` gains `'info'` (its own icon and a 11.44:1 color
  pairing). Informational is not urgent, so it renders as `role="status"` rather
  than the `role="alert"` warnings and errors keep — interrupting a
  screen-reader user to say "still waiting" is exactly the assertive-live-region
  misuse SC 4.1.3 warns about.

The banner's full 27-row input cross-product is now pinned as a literal table.

**Session tokens are decoded correctly.** A ScribeAR session token is not a JWT:
it is `base64url(payloadJSON).base64url(HMAC)` — two segments, payload first.
The expiry decoder read `parts[1]`, as a JWT's payload index, so it fed the raw
signature to `JSON.parse` and returned `null` for every token this system has
ever issued. Both callers treat `null` as "unknown expiry", so the failure was
silent and total: no proactive refresh timer was ever armed on any connection,
and every socket open burned a refresh round-trip before it could send AUTH.

**Failing refreshes now converge instead of looping.** If that refresh call
failed, the client returned without sending AUTH at all; the Node Server's 5 s
watchdog closed the socket 1008 `auth-timeout`; and because the socket had been
open for those 5 s — longer than the transport's 1 s stable-connection threshold
— the reconnect backoff reset every cycle. The result was an unbounded ~1 s
hammer loop against session-manager that the user saw only as "Reconnecting…".
Refresh now retries with exponential backoff against a consecutive-failure
budget counted _across_ reconnects, so a reconnect cannot refill it, and
exhausting it is terminal.

**There is a terminal connection state.** `SessionConnectionStatus.TERMINAL` is
entered when a fault cannot be retried away: a 1008 close whose reason can never
succeed (`missing-scope`, `session-mismatch`), three consecutive 1008 closes for
any other reason, an exhausted refresh budget, or a stream schema mismatch. This
aligns the viewer with the kiosk, which already treated 1008 as terminal. The
session stays `ACTIVE` in TERMINAL, so the captions already on screen survive
and the Leave button remains available to rejoin with.

That state is also what finally gives `selectError` a consumer — until now
"Network error - retrying.", "Failed to refresh session token." and "Session
stream protocol mismatch." were written to Redux and read by nothing. The field
is narrowed to "why this session is unrecoverable" and rendered by the banner's
terminal branch, so every value written there reaches the user.

**Reload resumes visibly.** `start(stored)` did not emit `sessionIdentity`, so
after a page reload `clientSessionService.session` stayed `null`, every
`setConnectionStatus`/`setSessionStatus` early-returned, and a reloaded viewer
got no banner at all — not even with a dead socket. It now re-announces the
resumed identity.

The viewer also gains the `INVALID_REQUEST` branch that the kiosk already has: a
session whose transcription provider does not exist on this deployment is
reported as an error naming what an administrator has to fix, not as a retry
that can never succeed.
