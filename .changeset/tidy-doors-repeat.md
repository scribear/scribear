---
'@scribear/transcription-display-ui': minor
'@scribear/live-translation-ui': minor
'@scribear/kiosk-webapp': minor
'@scribear/client-webapp': minor
'@scribear/standalone-webapp': minor
---

Fix auto-scroll disengaging when nobody scrolled, and give translated captions
scrollback support.

Auto-scroll is now only ever switched off by a scroll event attributable to a
real input gesture, decided from live distance-to-bottom rather than from a
cached scroll direction. This stops viewport-resize clamps, sub-pixel dither
under zoom, lagging iOS scroll reporting and rubber-band settle from reading as
a user scrolling back — the cause of captions silently freezing on an unattended
display. Reaching the bottom always re-engages, and each app can opt into
returning to the bottom after a configurable idle period following a scrollback.

Translated captions use the same behaviour and gain a jump-to-bottom control.

`useAutoScroll` is a breaking change for direct consumers: `textBottomRef` and
`setIsAutoScrollEnabled` are replaced by `jumpToBottom`, which re-engages and
pins in one call.
