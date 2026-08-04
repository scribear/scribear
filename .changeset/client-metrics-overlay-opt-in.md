---
'@scribear/client-webapp': minor
---

Client webapp: latency metrics are now opt-in, not always on.

- **Hidden by default.** The latency badge no longer sits over every reader's
  captions. It appears only when the URL fragment asks for it:
  `#metrics=latency`, or `#metrics=all` for every overlay. The value is a
  comma-separated list (`#metrics=latency,foo`) so further overlays can be added
  without another fragment parameter; unknown names are ignored rather than
  rejected, so a link written for a newer build still works on an older one.
- **`m` toggles.** Pressing `m` shows or hides the overlays at any time — with
  no fragment at all, `m` reveals everything, so a plain link can still be
  diagnosed on the spot. The key is ignored when another handler already claimed
  the event, when a modifier is held, or when focus is in a text field (typing
  `m` into the join-code box types an `m`).
- Parsing reads the fragment with `URLSearchParams`, so `metrics` coexists with
  other fragment parameters and leaves the existing `#config=<base64>` payload
  the url-config middleware consumes untouched.
