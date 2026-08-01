---
'@scribear/node-server-schema': minor
'@scribear/node-server': minor
'@scribear/kiosk-webapp': minor
---

A permanently misconfigured session now says so instead of pretending to
reconnect.

The Transcription Service closes the upstream socket with **1007** when it
rejects what the Node Server sent — in practice a `transcriptionProviderId`
that is not a key in the deployment's `provider_config.json`, which raises
`TranscriptionClientError("Invalid Provider Key")`. `_setStatus` special-cased
only 1013, so 1007 collapsed into the undistinguished
`transcriptionServiceConnected: false`, the Node Server's reconnect loop
re-sent the identical config forever, and every viewer sat on "Connection to
the transcription service was lost. Reconnecting…" — a promise nothing in the
system could keep, with nothing anywhere naming the cause.

`TranscriptionServiceDisconnectReason` gains `INVALID_REQUEST =
'invalid-request'`, in the published `node-server-schema` enum and in
node-server's local mirror (the two carry doc comments telling you to keep them
in sync; both are updated). The close-code mapping moves into a named
`closeCodeToDisconnectReason`, which now covers exactly the two closes the
transcription service makes *deliberately* — 1013 and 1007 — and leaves every
other close undistinguished, as before.

The two reasons stay separate on purpose: `AT_CAPACITY` clears on its own when
load drops, `INVALID_REQUEST` never clears without an operator. The kiosk banner
reflects that difference — it is the one branch in `deriveConnectionBanner` that
is an `error` rather than a `warning`, and it says an administrator has to check
the session's transcription provider rather than promising a retry.

The field is `Type.Optional` and the enum only gains a member, so a client built
against an older schema still validates every message; it simply falls through
to the generic branch it uses today.

The client-webapp banner is not in this change — `derive-connection-banner.ts`
was being restructured concurrently — and landed separately as the mirror of the
kiosk's branch.
