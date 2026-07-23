---
'@scribear/monitoring-sidecar': minor
---

Detect and alert on a transcription worker that died after startup (B1.3).

transcription-service's readiness was a hard-coded 200. It now fails when a
worker process has exited and reports `degraded` (still 200) when every worker
is saturated. The sidecar gains `scribear_asr_worker_alive` and a `workerDeadRule`
naming the worker.
