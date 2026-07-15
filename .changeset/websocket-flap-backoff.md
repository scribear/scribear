---
'@scribear/base-websocket-client': patch
---

Fix a reconnect storm where a WebSocket that opens then is immediately closed by
the server reconnects forever at `initialMs` instead of backing off. The backoff
attempt counter was reset the instant the socket reached `OPEN`, before the
connection had proven stable, so an upstream that accepted the socket and then
dropped the session (e.g. after auth/config) produced a tight ~1/sec loop. The
counter now resets only after the connection stays open for
`stableConnectionThresholdMs` (new option, defaults to the backoff `initialMs`);
connections that close before then keep their attempt count so repeated flapping
escalates the reconnect delay exponentially.
