---
'@scribear/monitoring-sidecar': minor
'@scribear/node-server': minor
---

Add the monitoring sidecar (Part A items A1 + A3) and the node-server
observability log lines it depends on.

The sidecar is a standalone service that parses the other services' JSON logs
into metrics, polls their liveness/readiness probes, evaluates the failure-mode
alert rules in-process, and serves both a JSON snapshot and a Prometheus text
endpoint. All state is in memory.

node-server gains three `info` log lines that carry signals which previously
existed only in memory: WebSocket close code/reason (server- and
peer-initiated) and upstream transcription connection state transitions.
Without these the upstream-flap and close-code metrics are not derivable from
logs at all. No behaviour changes, and the added lines are off the audio hot
path.
