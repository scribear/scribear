# @scribear/monitoring-sidecar

## 0.3.0

### Minor Changes

- c910a6a: Stop disconnecting saturated sessions with "Client sent audio too quickly", and
  stop blaming the client for the service's own stall (§3 T2).

  **The check never measured what it was named after.** `_decode_audio` raised
  `TranscriptionClientError("Client sent audio too quickly.")` whenever
  `NPCircularBuffer.append` returned a non-empty tail. There is no clock anywhere
  in that function: `extra` is non-empty iff **one** `append` call carries more
  samples than the buffer's free space, i.e. iff a single execution batch exceeds
  ~30 s of audio (the buffer is `2 × max_buffer_len_sec` and force-finalization
  purges back down to `max_buffer_len_sec` after every pass, so free space at the
  start of a pass is always at least that). A batch is everything that arrived
  since the single worker last cycled back to that job under round-robin EDF, so
  its size is `client_rate × scheduling_gap` — and the gap is entirely
  service-controlled.

  A correctly paced client therefore trips this precisely when the _service_
  stalls. That is the documented CPU cliff, exactly: 1 session, gap 2.4 s,
  survives; 3 sessions, gap 23.0 s, degrades but survives; 6 sessions, gap 45.9 s,
  crosses the 30 s line and all six die with zero transcripts — the client's rate
  identical in all three. Reaching it on rate alone needs roughly 6x realtime on
  CPU and 60x on GPU, which is why the test-audio `speedup` knob measured +0 at
  3.0x on a GPU.

  **Why the failure was total rather than partial**, and why the fix is "do not
  raise" rather than "close more accurately": any job exception permanently kills
  the transcription job in `worker_process_manager.py`, independently of and prior
  to the socket close in `transcription_stream_controller.py`. There was no
  variant of raising that left the session alive. The overrun is now dropped and
  counted, in both the whisper-streaming and lumen-granite decode paths (they
  share the counter, so they could not diverge on what it means).

  **A latent accounting bug had to be fixed in the same change**, because this is
  what makes it live. Both providers incremented `_total_decoded_samples`,
  `AUDIO_SECONDS_DECODED` and the cumulative `asr_input` stage reading by the
  **full** batch, including the samples `append` had just rejected. That was
  harmless only because the session died on the spot. The moment sessions survive
  an overflow, charging the timeline for audio that never entered the buffer
  shifts every subsequent word timestamp by the dropped duration, permanently and
  cumulatively. All three now count retained samples only, and the chunk ledger
  records the retained span. This is also what finally makes
  `audio_stages.py`'s ingress→asr_input gap measure the overflow its comment
  always claimed it measured — before the fix that gap was pinned at zero.

  **Renamed end to end**, since the old name asserted a cause the metric cannot
  observe: `AUDIO_TOO_FAST` / `audio_too_fast_total` →
  `audio_dropped_buffer_full`, with a companion
  `audio_dropped_buffer_full_seconds` because the event count alone never said how
  much audio was lost — the same count/seconds pairing `buffer_overflow` already
  has. The chain is Python enum → Python registry →
  `GET /metrics/status` (`audioDroppedBufferFullTotal`,
  `audioDroppedBufferFullSecondsTotal`) → sidecar schema → sidecar registry
  (`scribear_asr_audio_dropped_buffer_full_total`,
  `scribear_asr_audio_dropped_buffer_full_seconds_total`). Both new body fields
  are **optional**, for the reason the strictness rule already allows and
  `asrDroppedPeriodsTotal` already uses: during a rolling upgrade the sidecar polls
  a service that still sends the old name, and requiring the new one would turn
  every transcription metric into a `malformed` poll. Unlike dropped periods this
  needs no support gauge — nothing falls back to a different signal, so "not
  reported" and "zero" call for the same behaviour.

  **The alert was wrong in all three of its dimensions**, not just its wording.
  `asr-audio-too-fast` was CRITICAL, on `PipelineStage.UPLINK`, advising the
  operator to "check for a misbehaving or replaying client". It is now
  `asr-audio-dropped-buffer-full`, **WARNING**, on **TRANSCRIPTION**:
  - **Stage**, because it fires on our own scheduling gap and used to send the
    operator after the one component that was behaving correctly.
  - **Severity**, because it no longer disconnects anyone. What remains is
    degradation of the same kind as the force-finalize case beside it in the same
    rule, and the T1 saturation rules already own the CRITICAL for the cause.
  - **Threshold stays 0**, deliberately, rather than gaining a tolerance knob:
    unlike force-finalized audio — which is still transcribed, just cut early —
    dropped audio produces no captions at all, so a healthy deployment reads zero
    and any non-zero window deserves a card. The summary now leads with the
    seconds lost rather than a count of sessions "rejected".

  Raising the cliff itself — bounded-tail transcription, so an oversized batch
  becomes transcribable rather than merely survivable — is deliberately out of
  scope and stays tracked in `NEXTSTEPS-CPU-Whisper.md` §4.

- f038a16: Count dropped job periods exactly, and alert on the overrun tail between the two
  existing T1 rules (§3 T1).

  **The failure, restated.** The whisper-streaming provider re-transcribes its
  unfinalized buffer every `job_period_ms`. When a pass overruns, `worker_process.py`
  advances the job's `period_start_ns` by whole periods until it passes now, so the
  missed periods are **dropped, never queued**. No exception, no backlog, no log
  line: the effective period silently becomes a multiple of the configured one while
  captions get staler and every counter, probe and health check stays green. Measured
  on an RTX 5070 Ti with whisper `turbo`, a full 30 s buffer costs ~680 ms against the
  CUDA config's 500 ms period — 1.36x budget, invisible everywhere.

  **The counter, and the wrong version of it.** The obvious build was a counter of
  observations where `asr_rtf >= 1.0`. That inherits the exact blind spot it was
  meant to close, and a live measurement proves it: RTF's denominator is the audio
  _that pass_ ingested, and a dropped period leaves more audio for the next pass, so
  RTF **falls** as periods are lost. At 1/2/3/5/8 concurrent sessions sharing one
  worker, mean RTF went 0.277 → 0.256 → 0.229 → 0.194 → 0.139 while the worker went
  26% → 94.5% busy and transcripts per 1000 chunks collapsed 190 → 48. At eight
  sessions periods were certainly being dropped and RTF read 0.139.

  So transcription-service now counts the real thing, in the only place that can see
  it. The `while` loop that advances `period_start_ns` runs once for the ordinary
  advance to the next period; every _additional_ iteration is a period the job will
  never run in. `iterations - 1` is therefore the exact number of dropped periods, and
  it is reported as `asrDroppedPeriodsTotal` per provider on `GET /metrics/status`,
  exported by the sidecar as `scribear_asr_dropped_periods_total`.

  **Where it rides out, and why there.** The count is scheduler state, so it is held
  on the pool's own `_JobEntry` and written into the `counters` dict that
  `JobSuccess`/`JobException` already carry — _not_ into the job's
  `JobCounterCollector`. A job is never told a period was skipped, cannot observe one,
  and must not be able to fabricate or suppress the count by overriding
  `drain_counters`; the pool-owned name (`worker_pool.DROPPED_PERIODS_COUNTER`) wins
  over a job that reuses it. Reusing the existing dict rather than adding a result
  type is deliberate: the parent already labels a `JobExecutionResult` with its
  provider and folds its counters into per-provider totals, so a dedicated
  scheduler-counter message would need its own label lookup and its own observer to
  say the same thing. The cost is one execution of lag — the count is only known after
  the segment loop, and results are queued per segment so transcripts reach clients
  immediately, so buffering them to attach an exact count would delay live captions to
  improve a metric. Monotonic totals make a one-period shift invisible in any windowed
  rate.

  Worth having for a single session, not only under concurrency: a lone stream whose
  buffer grows past what the GPU can do in one period drops periods with a perfectly
  healthy-looking RTF.

  **The tail alert.** `transcriptionTailOverrunRule` (WARNING, T1) covers the band
  between the two rules that already exist — `transcriptionSaturationRule` (CRITICAL,
  p95 RTF ≥ 1.0) and `transcriptionFallingBehindRule` (WARNING, mean RTF ≥ 0.45). That
  band is normal shape rather than a corner case: per-pass cost tracks the length of
  the unfinalized buffer, so a healthy provider's distribution is wide by
  construction. Measured sub-job spread on one session was p50 0.235 / p95 0.653 / max
  0.840, which is a provider that can sit at a 0.24 median and still overrun every
  time its buffer gets long.

  It fires on the share of _scheduled_ periods that were dropped —
  `drops / (drops + passes)` over `rateWindowMs` — rather than a raw rate, so one
  threshold holds across every `job_period_ms` and so the first poll after a sidecar
  restart (which folds a service's whole lifetime total as a single delta) reads as a
  lifetime average rather than as a window's worth of drops.
  - **Threshold `ALERT_ASR_DROPPED_PERIOD_RATIO`, default 0.01 — reasoned, not
    measured**, unlike the 0.45 beside it, which came from a 42-minute live capture.
    No capture of a provider that is dropping periods exists yet. 1% is what the
    fallback path below implies, so the alert means roughly the same thing whichever
    signal produced it, which matters because it can switch signals mid-incident. A
    dropped period is a lost caption update rather than a tolerance, so a healthy
    deployment should read zero.
  - **Fallback: `asrRtf{quantile=p99} >= 1.0`** when the counter is absent. Not
    hypothetical — during a rolling upgrade the sidecar polls a transcription-service
    that predates it, and the p99 gauge has been on the wire since B1.2. Same
    prefer-reported-then-fall-back shape the per-provider job-period work established
    in this file. It is strictly worse (a fixed 1% grid, no distance past the line, and
    computed over the far end's ring rather than `rateWindowMs`) which is why it is
    second, and the alert text says which signal fired.
  - **`scribear_asr_dropped_periods_supported`** exists because "no series" is
    ambiguous in the other direction: a healthy new service sends an empty array and a
    counter that never increments creates no series either, so absence would mean
    _either_ "nothing dropped" or "nothing counting" — and those demand opposite
    responses. Published rather than guessed, and independently the honest answer to
    "why did this alert change shape mid-upgrade".
  - **No double-reporting.** Silent while `asrRtf{p95} >= ALERT_RTF_P95`: percentiles
    are monotone, so p95 ≥ 1.0 implies p99 ≥ 1.0 and the fallback path would always
    co-fire, and on the counter path a p95 at realtime means ≥5% of passes overrun,
    which is the outage the CRITICAL owns. Also silent while the **mean** rule is over
    its threshold — a judgement, not an implication: both are WARNING, same provider,
    same stage, same three levers, so a second card adds prose and no decision. This
    rule owns exactly the band the mean rule does not. The two hand off in the right
    direction, because severe dropping _lowers_ mean RTF: a provider that falls out of
    the mean rule's band lands in this one rather than in silence.
  - **Floored on samples, `ALERT_ASR_TAIL_MIN_JOBS` default 100**, five times the mean
    rule's floor, for two reasons that land on one number. A reported p99 is only a
    percentile given samples: at 100 it is the second-worst pass, at 24 (a 120 s window
    at lumen_granite's 3000 ms period) it _is_ the worst pass, and a rule on that flaps
    on one slow inference. And 100 is what stops a 1% share firing on a single dropped
    period. The cost is explicit: a provider whose period is long enough that
    `ALERT_RATE_WINDOW_SEC` holds fewer passes than this gets no tail alert at all — at
    the default window, anything above ~1.2 s, lumen_granite included. Widen the window
    for such a deployment rather than lowering the floor.
  - **The levers are not the CRITICAL's.** One stream is one job and its passes run one
    at a time, so neither workers nor CPU shortens a pass already alone on the GPU.
    `max_buffer_len_sec` (cost tracks buffer length, and this rule fires on the
    long-buffer tail specifically), `job_period_ms`, and model size are what move the
    number.

  **`providerJobPeriodMs` is now populated**, which closes the duplication the previous
  changeset left open. `GET /metrics/status` reports the period each provider schedules
  with, taken from the provider itself via a new
  `TranscriptionProviderInterface.job_period_ms` (concrete, defaulting to `None`, so a
  provider added later cannot fail to construct over a telemetry question) rather than
  from a `getattr` on provider config — which would be wrong for `debug`, whose period
  is a literal, now the single `DEBUG_JOB_PERIOD_MS` constant that `register_job` also
  reads. A provider with no period to state is **omitted** from the map rather than
  given a placeholder, so the poller's "no period known, publish nothing" path still
  means what it says. The sidecar already preferred a reported period, so
  `TRANSCRIPTION_JOB_PERIOD_MS` becomes a fallback for a service too old to send one;
  `scribear_asr_job_period_ms{source=reported|configured}` shows which is in use, and
  `deployment/compose.yml`'s bare `${MONITORING_JOB_PERIOD_MS:-1000}` stops mattering
  for any provider the service names.

  Both new fields on the metrics body are **optional**, unlike everything else in that
  schema, for the reason the strictness rule already allows: it is precisely the
  mixed-version poll that omits them, and turning that into a `malformed` response
  would take every transcription metric down to enforce fields with working fallbacks.

- 705aacf: Re-key the T1 saturation CRITICAL onto the dropped-period share, and stop
  flooring a share on a count the share erodes.

  **The signal was wrong in kind, not merely mis-thresholded.** `asr-saturation`
  fired on `asrRtf{quantile=p95}`, which is the obvious "transcription is slower
  than realtime" number and which _falls as the service saturates_. RTF's
  denominator is the audio a pass ingested; a dropped period leaves that audio for
  the next pass to swallow, so per-pass cost amortises over a longer buffer.
  Measured at 1/2/3/5/8 concurrent sessions on one worker: mean RTF 0.277 → 0.256
  → 0.229 → 0.194 → 0.139 while the worker went 26% → 94.5% busy and transcripts
  per 1000 chunks collapsed 190 → 48. At eight sessions captions were badly behind
  and the alert was not merely silent — it was moving further from firing.

  The threshold had already been raised 1.0 → 2.0 in the previous release, because
  1.0 fired on a _healthy_ single session (measured p95 0.96–1.28). That is the
  same fact from the other side: on this signal the healthy and the saturated
  values interleave, so no bar separates them. Raising it bought silence, not
  correctness, and the changeset that did it said so.

  `asr_dropped_periods_total` measures the thing exactly and has the right slope —
  it rose monotonically through the same sweep. The CRITICAL is now keyed on the
  share of scheduled periods that ran no pass at all, at **0.5**: between the
  3-session point (26.4%, transcripts down ~19%) and the 6-session one (66.3%,
  transcripts collapsed), and 4.4× the measured healthy share of 11.3%. The
  warning below it keeps 0.25, so the two rules now read one quantity at two bars
  and suppression between them is a plain numeric ordering rather than a judgement
  about two different metrics.

  `ALERT_RTF_P95` survives only as the fallback for a transcription-service too old
  to report the counter — the same shape, and the same rolling-upgrade argument, as
  the tail rule's existing p99 fallback. Both can be deleted together once no such
  service is polled. Without it, a rolling upgrade would silently have no T1
  CRITICAL at all.

  **A pass floor on a rule about dropped passes.** Both dropped-period paths were
  floored at 100 _passes_ in the window. Dropping a period removes a pass, so that
  floor rises out of reach exactly as the fault it guards gets worse — the same
  wrong slope, reintroduced in the guard. It was also unreachable outright for any
  long period: a 120 s window holds ~24 scheduled periods at the CPU templates'
  5000 ms `job_period_ms` (measured on a live CPU stack) and ~40 at
  `lumen_granite`'s 3000 ms, so the tail alert was **silently inactive on every CPU
  deployment** and on that provider.

  The floor is now split by what each path actually measures. The counter paths
  take `ALERT_ASR_SCHEDULED_PERIOD_MIN_COUNT` (20 scheduled periods, `drops +
passes` — a total that dropping does not move). The p99 fallback keeps
  `ALERT_ASR_TAIL_MIN_JOBS` at 100 passes, where the argument is about percentile
  resolution and genuinely applies. 20 rather than 100 because the second reason
  for 100 — stopping a _1%_ threshold firing on one dropped period — expired when
  that threshold became 0.25; at 20 scheduled periods the warning needs 5 drops and
  the critical 10.

  **Also fixed: `ALERT_RTF_P95` did not default to its own default.** Its schema
  said `Type.Number({default: 1.0})` while `DEFAULT_THRESHOLDS.rtfP95` said 2.0,
  and unlike its neighbours it did not use the `OPTIONAL_NUMBER`/`threshold()`
  pattern — so the schema default won and any deployment that left the variable
  unset got exactly the 1.0 that live verification had shown fires on a healthy
  stack. It now falls back to the compiled default like every other threshold, and
  `.env.example` ships it empty so the number lives in one place.

  **Also fixed: the first poll folded a polled service's entire lifetime.**
  `AbsoluteStatusPoller._advance` differences each absolute total against the
  previous reading, defaulting to 0 when it has never seen the series. On the
  sidecar's _first_ poll that default is wrong in one specific way: the service it
  is polling may have been up for days, so its whole history landed as a single
  increment stamped `now`. Every raw windowed rule then fired immediately —
  `decodeDropRule` at 10, `bufferOverflowRule` at 5, `upstreamChurnRule` at 3 — on
  events that predate the sidecar, and cleared itself one window later. The ratio
  rules were already immune, because a lifetime fold lands in numerator and
  denominator together.

  The first successful poll now records baselines without emitting increments.
  Gauges are unaffected, so a primed poll still publishes a full picture of current
  state; only counter deltas are skipped, and the cost is up to one poll interval
  of counts at startup — which is the correct answer for a rate rule, since those
  counts happened before anyone was watching. A _service_ restart is the opposite
  case and still folds in full: the baselines are cleared on a `processUid` change
  and the service's own counters really are near zero then.

  New: `ALERT_ASR_DROPPED_PERIOD_CRITICAL_RATIO`,
  `ALERT_ASR_SCHEDULED_PERIOD_MIN_COUNT`, both plumbed through `compose.yml`.

- 64a2a70: Export the binary-before-auth drop counters, and stop transcription-service
  closing the socket on an early binary frame.

  A binary frame arriving before AUTH — or, on transcription-service, before
  CONFIG — used to close the socket with 1008. That turns a recoverable client
  ordering bug into a silent outage: the client auto-reconnects, re-sends AUTH,
  its first audio chunk again beats AUTH_OK, and the loop repeats forever with
  no audio delivered and nothing naming the cause. node-server hit exactly this
  and was fixed the same way; transcription-service now drops the frame, counts
  it, and leaves the connection open. A peer that never completes the handshake
  at all is still closed by the existing `ws_init_timeout` watchdog.

  node-server's `binaryBeforeAuthDropsTotal` had been counted and serialised for
  some time but consumed by nothing — no registry counter, no `/metrics` series,
  no panel, no alert. It and transcription-service's two new counters are now
  wired through the sidecar as:
  - `scribear_node_binary_before_auth_drops_total`
  - `scribear_asr_binary_dropped_before_auth_total` (per provider)
  - `scribear_asr_binary_dropped_before_config_total` (per provider)

  All three wire fields are optional, so a node-server or transcription-service
  built before this change is polled without failing validation: absent records
  no increment rather than a zero.

  No alert thresholds — none of these counters has a measured baseline yet.

- a000a0a: Seed the monitoring canary's room and device instead of provisioning them by
  hand, and delete `MONITORING_CANARY_DEVICE_TOKEN`.

  The synthetic canary was the last credential in the fleet an operator made by
  hand, and the longest-shipping one. Arming it meant registering a device through
  the admin API, activating it, scraping a `DEVICE_TOKEN` out of a `Set-Cookie`
  header, pasting it into `.env`, then creating a room, attaching the device,
  marking it the source and giving the room a standing schedule. One of those steps
  — which room the device went into — silently decided whether fixture speech could
  reach a live lecture. All of them are now gone.

  **One secret, `CANARY_DEVICE_SECRET`, held by the Session Manager and the
  monitoring sidecar and by nothing else.** At boot the Session Manager
  idempotently seeds, at fixed uids: the room `MONITORING-CANARY`, one activated
  source device in it, and one standing open-ended `ON_DEMAND` session. The
  device's stored credential is `bcrypt(HMAC-SHA256(secret, deviceUid))`, which is
  exactly what the sidecar derives for itself, so no token is ever transmitted,
  pasted or written down. Unset seeds nothing and leaves the canary off, which is
  the state a deployment that never provisioned one is already in.

  This is the scheme `TEST_AUDIO_DEVICE_SECRET` introduced for the operator
  test-audio devices, reusing the same derivation
  (`@scribear/session-manager-schema/test-audio`) rather than growing a second
  implementation of it — a mismatch between two copies is invisible until a device
  fails to authenticate and looks exactly like a wrong secret.

  **A second secret rather than reusing `TEST_AUDIO_DEVICE_SECRET`.** The two gate
  different features and sharing one would tie two unrelated decisions together:
  arming the operator test devices would also start an unattended canary probe
  every few minutes, and retiring them would silently stop monitoring. It would
  also hand a third service the root key every synthetic device's credential is
  derived from — the independence the per-device HMAC exists to provide.

  **The room assignment is enforced, not just documented.** A device token reaches
  only its own device's room, so that binding is the entire safety boundary, and
  making it in code is stronger than an operator making it by hand: the room is
  seeded under a reserved uid no other room can hold, a re-run repairs a drifted
  assignment instead of adding a second one, and room-management now refuses to
  move the device into another room (409 `CANARY_DEVICE_NOT_ASSIGNABLE`) or to hand
  the canary room a different source device (409 `CANARY_ROOM_NOT_ASSIGNABLE`).
  Those guards are the same ones the demo and test-audio rooms carry, and they
  close the same gap: `WOULD_LEAVE_ROOM_WITHOUT_SOURCE` stops covering the moment
  someone deletes the canary room, which is the documented way to retire it, and
  that leaves a roomless device holding a valid credential one `add-device-to-room`
  from a lecture hall. The canary is the sharpest case of it, because it is the
  only synthetic source that streams **unattended**, on a timer, with nobody
  watching a meter.

  The session is a standing open-ended `ON_DEMAND` one rather than
  `autoSessionEnabled`, for the reason the test-audio seeder records:
  `autoSessionEnabled` creates nothing on its own — it is a master switch over a
  room's `auto_session_windows` rows, and with no window there are no slots and no
  session.

  Idempotent by construction: every insert is keyed on a reserved uid, never on a
  name, so two instances starting together cannot duplicate. Tested across three
  boots on one database with every touched table's row count asserted unchanged,
  plus convergence after a deleted room, an ended session, a de-activated device
  and a rotated secret, and the round trip proved end to end against a real server.

  Operators running the canary must replace `MONITORING_CANARY_DEVICE_TOKEN` with
  `MONITORING_CANARY_DEVICE_SECRET` in `.env`; see `deployment/UPGRADING.md`, which
  also covers rotation, retirement ordering, and cleaning up the hand-made device
  this leaves behind.

- 124ad14: Config Check now reports on the four secrets admin-server deliberately never
  holds, without being given any of them.

  `JWT_SECRET`, `NODE_SERVER_KEY`, `NODE_SERVER_SERVICE_KEY` and
  `TRANSCRIPTION_API_KEY` are invisible to admin-server by design, so a
  deployment could sit on all four as `CHANGEME` placeholders with Config Check
  entirely green. The obvious fix — hand admin-server copies so it can check them
  — makes every deployment strictly less secure in order to report on its
  security, and was rejected by the plan's own trust-boundary table.

  Instead the service that already holds all four classifies its own copies.
  node-server's `AppConfig` gains a `secretPlaceholders` getter applying the same
  case-insensitive `CHANGEME` substring rule Config Check already uses, exposed
  as four booleans on its existing authenticated `GET /status`
  (`SECRET_PLACEHOLDERS_SCHEMA`). The monitoring sidecar already polls that
  endpoint with `NODE_SERVER_SERVICE_API_KEY`, so it re-exposes the
  classification on a new `GET /api/monitoring/v1/config-audit` —
  unauthenticated and backend-network-only, the same trust boundary `/metrics`
  and `/probes/readiness` already carry. admin-server reads that over the compose
  network it already uses for the sidecar's build info and translates
  node-server's env var names to the deployment `.env` names. Four booleans move;
  no secret value does, and no service gains a credential it did not already
  have. Verified live with `docker exec admin-server env`.

  Why node-server rather than session-manager or transcription-service, which
  also hold some of these: node-server is the only service that holds **all
  four** and already has an authenticated status endpoint an observability
  consumer polls. So this phase needed no change to either of those services, no
  new env var anywhere, and no `COMPOSE_FILE_VERSION` bump.

  **The new field is deliberately a sibling of `sessions`/`sessionsTruncated` on
  the route response, not part of `STATUS_PROCESS_SCHEMA`.**
  `NODE_SNAPSHOT_SCHEMA` spreads `STATUS_PROCESS_SCHEMA.properties`, so the
  obvious placement would have silently published a secret classification into
  the Redis fleet-telemetry namespace, admin-server's `FleetSnapshot` and the
  fleet dashboard — three more copies to go stale, for data with exactly one
  reader.

  Also deliberately **not** a Prometheus metric. Routing it through `/metrics`
  would gate these findings behind the optional `monitoring` compose profile;
  Prometheus and Grafana are opt-in, and these four secrets are live in every
  deployment. It is a classification, not a measurement.

  **`unavailable` is a first-class answer, never silence.** `AbsoluteStatusPoller`
  gains an `enabled` getter so `nodeServer.status` can distinguish "will never
  poll" (`disabled` — the sidecar has no service key), "has not polled yet"
  (`not-yet-polled`) and the existing `POLL_ERROR_REASONS` from a failed poll.
  Config Check turns any of them into its own
  `secret-placeholder-audit-unavailable` finding (warning; advisory in
  development, matching the four secret findings), so a broken sidecar reads as
  "cannot currently check" and never as a clean bill of health. Admin-server
  validates the whole `/config-audit` body with `Value.Check` against a TypeBox
  schema before dereferencing any field — the same thing
  `NodeStatusPollerService._parseBody` does one hop upstream, so both ends of the
  wire are validated alike. The schema stays open to unknown properties on
  purpose, so a _newer_ sidecar's extra fields still validate and upgrading the
  sidecar first cannot blind Config Check.

  **Known limitation, named in the finding's own remediation text:** a
  placeholder `NODE_SERVER_SERVICE_KEY` can only ever surface as the generic
  `secret-placeholder-audit-unavailable`, never as its own finding. That key
  guards `/status` itself, and node-server's `ServiceAuthService` refuses to
  construct while it contains `CHANGEME` — a deliberate pre-existing fail-closed
  design — so the endpoint 500s before it can self-report on that specific key.
  The deployment still never reads as clean; the operator gets "something is
  wrong with node-server's status auth" rather than the variable's name. Not
  worked around by giving a second service a way past node-server's boot check.

- 2781c05: Tell a source that its session is already over, instead of letting it stream
  into a dead one.

  A **source** (kiosk or synthetic device) that opened a socket for a session
  whose `effectiveEnd` had already passed was never told. `registerSource`
  published `SessionEndedChannel` from inside its own `await` — `_openSession`
  armed the end timer, found the end in the past, and published synchronously —
  while the connection did not subscribe to that channel until the `await`
  resolved. The publish landed on an empty channel. The source got `authOk`, no
  `sessionEnded`, no close, and went on forwarding audio into a session the server
  considered over, holding an upstream transcription connection for as long as the
  kiosk kept the socket up. Nothing tore it down: teardown is driven by
  `_unregisterSource`, which is driven by a close that never came. `#184` fixed the
  viewer half of this and explicitly did not fix this half.

  The likeliest real-world trigger is not the operator race but a **stale kiosk
  schedule**: `kiosk-service.ts`'s `poll.on('error', () => {})` means the schedule
  long-poll can be dead for hours with no signal, and a kiosk acting on a stale
  schedule confidently connects to a session that ended long ago.

  **Subscriptions now come before registration, for both roles.** The event bus is
  synchronous, so anything published during `registerSource` reaches this
  connection instead of nobody. This is the ordering the client path had already
  been given, with the comment explaining why; sources now get the same rule. The
  early-return paths (`_closed` mid-await, orchestrator failure) release those
  subscriptions rather than leaving four listeners attached to a dead socket.

  **Nothing is written to the socket before `authOk`.** Moving subscriptions above
  registration means a bus message can now fire while the connection has not been
  told its auth succeeded, and both webapp clients hold their WebSocket handshake
  open until it arrives. The service therefore keeps an outbound gate shut until
  the controller reports the send (`onAuthAcknowledged`, replacing
  `publishCurrentStatus`). Live-stream messages that arrive early are dropped —
  `sessionStatus` is superseded by the snapshot sent immediately after `authOk`,
  and transcripts have no replay semantics — which is exactly what happened before,
  when those subscriptions simply did not exist yet. `sessionEnded` is the one
  message that must not be dropped, so it is latched and delivered in protocol
  order: `authOk`, then `sessionEnded`, then close 1000.

  **No upstream is dialed for a session that is already over.** `_openSession`
  used to construct and start the upstream _before_ `_armEndTimer` discovered the
  end had passed, so an abandoned session took a transcription-service connection
  with it. The effective end is now checked the moment the first config surfaces,
  and `registerSource` throws `SessionAlreadyEndedError` without dialing anything
  and without creating a `SessionState`. That error is distinct from an
  orchestrator failure on purpose: an unreachable Session Manager is _broken_ and
  earns 1011, whereas this session is merely _over_ and earns a clean 1000 with
  `sessionEnded` — the kiosk already distinguishes those, and collapsing them
  would put a finished session into a reconnect loop. Not creating the state also
  removes the knock-on: no stale `SessionState` lingers in `_sessions` holding an
  upstream, answering `getStatus`, and appearing in `/status` for a session nobody
  is serving.

  The single-publisher guarantee `#184` established is untouched: the refusal
  publishes nothing on the bus, so an end-watch a viewer holds is still the only
  thing that announces the end to that session.

  **Observability.** A source arriving at a finished session is now counted and
  named, because downstream it is otherwise indistinguishable from an ordinary
  session end (a `1000 session-ended` close either way) while meaning something
  quite different:
  - a warn log line, `source registered onto an already-ended session`, carrying
    the `effectiveEnd` the config reported;
  - `summary.endedSessionRegistrationsTotal` on `GET /status`, optional on the
    wire so an older publisher does not fail the strict `Value.Check` that the
    Redis fleet snapshot is read back through;
  - `scribear_node_ended_session_registrations_total` in the monitoring sidecar,
    which skips the advance rather than recording a zero when the field is absent.

- 4016368: Alert on transcription quietly losing its period budget, before captions are
  visibly late (§3 T1, early warning).

  The whisper-streaming provider re-transcribes its unfinalized buffer every
  `job_period_ms`. When a pass takes longer than that period, nothing errors and
  nothing queues: `worker_process.py` advances the job's `period_start_ns` by whole
  periods until it passes now, so the missed periods are **dropped** and the
  effective period silently becomes a multiple of the configured one. Captions get
  staler while transcript counts, health checks and every error counter stay clean.
  Measured on an RTX 5070 Ti with whisper `turbo`, a full 30 s buffer costs ~680 ms
  against the CUDA config's 500 ms period — 1.36x budget, invisible everywhere.

  `transcriptionFallingBehindRule` warns when the **mean** RTF over the alert window
  reaches `ALERT_ASR_DUTY_RATIO` (0.8 by default), per provider. Because each period
  ingests roughly one period of live audio, RTF is the duty ratio: 0.8 means four
  fifths of the budget is gone. `transcriptionSaturationRule` still owns the 1.0
  line as a critical, so this rule does not escalate — the point is to fire while
  captions are still on time, and to name the levers that actually move the number
  (`job_period_ms`, `max_buffer_len_sec`, model size — not more workers or CPU,
  since a stream's passes run one at a time).

  A mean and not the p95 the reported percentiles already offer, for two reasons.
  Per-pass cost tracks the length of the unfinalized buffer, which grows between
  finalizations, so in healthy operation the worst few percent of passes sit well
  above the typical one and a p95 pinned at 0.8 would fire on a provider whose real
  duty cycle is 0.3. And a reported percentile cannot be re-windowed: it is computed
  over transcription-service's own 4096-sample ring, which never expires by time, so
  it keeps reporting the same figure after the session that produced it has ended.
  The sidecar therefore differences the RTF histogram's lifetime `sum` and `count`
  into two new counters, `scribear_asr_duty_ratio_sum_total` and
  `scribear_asr_duty_ratio_jobs_total` — both already on the wire since B1.2 and
  consumed by nothing until now. Averaging over the rate window makes "sustained"
  structural: no single spiky period can move it, and an idle provider contributes
  nothing at all rather than a stale high-water mark.

  `buffer_overflow_seconds` stays out of the firing condition — it is a consequence,
  it has its own T2 rule, and VAD gating usually keeps the buffer short of the cap,
  so requiring it would blind the rule to the common case. It is reported in the
  alert message when non-zero, because it tells the operator whether audio is
  already being discarded.

  The threshold default is **0.45**, measured rather than guessed. 42 minutes of
  `npm run asr:load` against a live RTX 5070 Ti stack (whisper `turbo`, 500ms period,
  30s buffer, `num_workers: 1`) put healthy single-session operation at 0.28 on a
  speech-sparse fixture and 0.33 on a speech-dense one, with the worst of 388 rolling
  120s windows at 0.355 — so 0.45 clears measured-healthy by 27% and fired zero false
  alarms. The first draft used 0.8, which the same capture showed is not an early
  warning at all: it needs a 2.9x per-pass regression to trip, by which point the
  provider is at 80% of realtime and this is the outage rather than the hour before it.

  **Known limitation, documented on the rule.** This cannot see the shared worker
  saturating under concurrency. RTF's denominator is the audio ingested by that pass,
  and overrun periods are dropped whole, so duty ratio _falls_ as sessions pile onto
  one worker: measured 0.277 / 0.256 / 0.229 / 0.194 / 0.139 at 1/2/3/5/8 sessions
  while the worker went 26% to 94.5% busy and transcripts per 1000 chunks collapsed
  190 to 48. A quiet duty ratio is therefore not evidence transcription is keeping up.
  The metric with the right slope is the worker busy fraction, already on the wire;
  nothing watches it yet.

- f2eb8c5: Stop silently misscaling `scribear_asr_period_utilization`, and make the job
  period per provider.

  The derived period-utilization series divides reported job execution time by
  `TRANSCRIPTION_JOB_PERIOD_MS`, a single sidecar env var that defaulted to 1000.
  `job_period_ms` is a **per-provider** field of transcription-service's
  `provider_config.json`, and the shipped CUDA template
  (`deployment/provider_config.cuda.template.json`) configures three different
  values in one file: `whisper` and `crisper_whisper` at 500 ms, `lumen_granite` at
  3000 ms. (`debug` has no such field at all — its period is hardcoded to 1000 ms
  in `debug_provider.py`, which is the only provider the old default was ever right
  for.) So the default matched none of the configured providers and the series was
  published 2x high for whisper and 3x low for lumen_granite, with no error, no
  warning and no way to tell from the number itself. Worse, the two statements of
  the period live in different files edited by different people at different times,
  so agreement was a coincidence rather than an invariant.

  `TRANSCRIPTION_JOB_PERIOD_MS` is now a per-provider map —
  `whisper=500,lumen_granite=3000` — with **no default**, and each provider's
  series is scaled by its own period. A provider that is not named publishes no
  period-utilization series at all, rather than one scaled by a guess: "no reading"
  is not the same claim as a bad reading, the same rule the fleet dashboard applies
  to audio status. A bare integer, the format this variable used to take, is
  rejected with an error naming the replacement instead of being applied to every
  provider. **Deployments must update this value**; `deployment/compose.yml` still
  passes `${MONITORING_JOB_PERIOD_MS:-1000}`, which the sidecar now logs as an
  error and treats as "no periods configured".

  Nothing else changes behaviour. `scribear_asr_rtf`, the T1 saturation rule and
  the new duty-ratio counters are measured by transcription-service itself and
  carry no dependency on the job period — that independence is why the T1 early
  warning was built on RTF, and it is preserved here.

  Two new pieces of visibility, because a suppressed series is invisible by
  construction:
  - `scribear_asr_job_period_ms{providerKey,source}` exports the denominator
    actually in use and where it came from (`configured` or `reported`). The period
    is the one dashboard input the sidecar cannot verify, so publishing it beside
    the ratio turns "silently wrong" into "visibly derived from 1000 ms, which is
    not what the provider config says". Its absence for a provider is the honest
    signal that no period is known.
  - A once-per-provider warning naming the provider and the variable, plus an error
    per rejected entry. Deliberately not an alert rule: `asrPeriodUtilization` is
    not alerted on at all, so an alert about its denominator would page on config
    hygiene while nothing consumes the series it protects.

  The real fix is for transcription-service to report the periods it is scheduling
  with, so the number is stated once. `GET /metrics/status` does not carry them
  today (nor does `GET /providers/health`, nor the Redis fleet plane), so the body
  schema gains an **optional** `providerJobPeriodMs` map and the poller prefers it
  over anything configured locally, per provider. When
  `metrics_controller.py` starts sending it, `TRANSCRIPTION_JOB_PERIOD_MS` can be
  deleted with no further sidecar change; optional rather than required so landing
  the two sides in either order never turns a healthy poll into a `malformed` one.

- 3bf85ca: The monitoring sidecar now selects the `asrDutyRatio` alert threshold per
  provider based on the inference device the transcription service reports,
  instead of using one global GPU-calibrated number for every deployment.

  A GPU provider keeps the existing 0.45 default. A CPU provider gets 0.7 — the
  value that was previously a manual `.env` override every CPU deployment had to
  discover for itself. A healthy CPU stack running `small`/4 measured 0.471,
  sitting exactly on the GPU alarm; the shipped `base` template measures 0.173.
  One global threshold cannot serve hardware an order of magnitude apart.

  The transcription service now reports `providerDevice` on `/metrics/status`
  (alongside `providerJobPeriodMs`), using the same reported-then-fallback
  shape: the sidecar prefers it, falls back to the GPU default for a service too
  old to send it (rolling upgrade), and a provider with no local device (`debug`,
  `lumen_granite`) is omitted from the map.

  The flat operator override `MONITORING_ASR_DUTY_RATIO` still wins over both
  per-device defaults, preserving the existing escape hatch. A new env var
  `MONITORING_ASR_DUTY_RATIO_CPU` (default 0.7) lets an operator tune the CPU
  default without affecting GPU providers.

### Patch Changes

- 64a2a70: Default the standalone audio meter's peak zones to -12 / -3 dBFS.

  The zone boundaries are applied to the held sample peak, but the defaults were
  taken from EBU alignment level, which is an RMS convention. A sine at -18 dBFS
  RMS peaks at -15.01 dBFS — 3 dB above the old warn boundary — so a correctly
  levelled, perfectly healthy speech signal rendered amber. For a lecture-room
  speech meter the boundary exists to guard headroom, which peak defines, so the
  "speech headroom" preset already present in the meter's own zone selector is
  the right default. Both alignment presets remain selectable.

  nginx's pinned CSP hashes cover the meter page's inline scripts and were
  recomputed to match.

  The admin dashboard's `rmsDbfsHigh` (-6 dBFS) is deliberately unchanged: it is
  an RMS threshold in a different system, and only its comment claimed parity
  with the meter's peak default.

- dc104ab: Deployment Check now shows what each container was built from, so an operator
  can confirm what is actually deployed and running.
  - **Every image is stamped at build time.** `BUILD_COMMIT`, `BUILD_REF`,
    `BUILD_TIME`, `BUILD_VERSION`, `BUILD_TAGS`, `BUILD_PR` and `BUILD_ORIGIN`
    become `SCRIBEAR_BUILD_*` environment variables and OCI image labels
    (`org.opencontainers.image.revision`/`.version`/`.created`, plus
    `org.scribear.build.pull-request`/`.origin`), so `docker inspect` answers the
    same question as the console. The block sits last in every Dockerfile, so
    changing commit invalidates no expensive layer.
  - **Every container reports it.** The four Node services answer
    `GET /build-info` from a route `createBaseServer` registers for them;
    transcription-service answers the same path from FastAPI; the four webapps and
    the reverse proxy serve an identical `build-info.json` generated at image
    build time by `tools/build-info/write-build-info.sh`. All of these are
    reachable only inside the compose network — nginx proxies none of them, and
    the proxy's own document is served on its plain-HTTP listener only, so no
    commit hash is published to the internet.
  - **Admin console — Deployment Check → Deployed versions.**
    `GET /api/admin/v1/deployment-versions` probes every container concurrently
    and renders a table of version, commit, branch, build time and image tags.
    Version skew is the headline: the commit the most containers report is taken
    as the deployment's, and any container that disagrees is named in a warning.
    This is the only place in the console that can see a half-finished upgrade —
    a stale container is a perfectly healthy container, so the health rollup stays
    green throughout.
  - **Old and local builds are distinguished, not blanked.** A container running
    an image from before this release answers 404 and is reported as
    `old image` rather than as unreachable — it is stale, not down.
    `build-containers.sh` stamps the real commit for local builds, marks them
    `origin: local`, and appends `-dirty` when the working tree has uncommitted
    changes; a stack started straight from a checkout (`npm run dev`) reports
    "nothing here was built by CI" instead of a table of blanks.
  - **`scribear-db` and `redis`** appear in the table as `n/a` with the reason:
    neither has an HTTP surface to report a build on.
  - **PR images are published again, named for their target environment.** A
    pull request into `staging` pushes
    `ghcr.io/scribear/<image>:staging-pr<n>`; into `main`,
    `ghcr.io/scribear/<image>:production-pr<n>` — so a reviewer can pull the
    exact build under review rather than rebuilding it, and tell at a glance
    which environment it's a candidate for, without cross-referencing the PR
    on GitHub. The tag moves with the PR head. Set the repository variable
    `PUBLISH_PR_IMAGES` to `false` to switch it off, or `true` to publish for
    every base branch (tagged `<base-branch>-pr<n>`). Fork PRs still build
    without publishing, since their `GITHUB_TOKEN` cannot push.

  Nothing new is required in `deployment/.env`. The six new admin-server base-URL
  variables all default to their compose service names.

- 5605d6b: Clear the open high-severity npm security advisories.
  - **fast-uri** → 3.1.4 / 4.1.1 — host confusion via a literal backslash
    authority delimiter (GHSA-v2hh-gcrm-f6hx). Shipped transitively through
    Fastify by the four server apps listed here.
  - **brace-expansion** → 1.1.16 / 2.1.2 / 5.0.7 — quadratic-complexity DoS.
  - **shell-quote** → 1.9.0 via an `overrides` entry (quadratic DoS in
    `parse()`); `concurrently` pins the vulnerable 1.8.4 and has no fixed release,
    so an override is the only route that does not downgrade concurrently.

  Lockfile / dev-tooling only — no workspace package's own dependencies changed.
  `npm audit` reports 0 vulnerabilities; workspace unit tests and `npm run build`
  pass.

## 0.2.0

### Minor Changes

- aa0cb65: Detect and alert on a transcription worker that died after startup (B1.3).

  transcription-service's readiness was a hard-coded 200. It now fails when a
  worker process has exited and reports `degraded` (still 200) when every worker
  is saturated. The sidecar gains `scribear_asr_worker_alive` and a `workerDeadRule`
  naming the worker.

- 6f8e5b9: Add the monitoring sidecar (Part A items A1 + A3) and the node-server
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

- 6f8e5b9: Add the synthetic canary (Part A item A2) to the monitoring sidecar.

  The canary authenticates as a registered ScribeAR device, joins the session
  active in that device's room, streams a known recording as a source using the
  real SAFP encoder, subscribes as a viewer on the `/client` route, and scores
  the captions that come back against the fixture's reference text.

  This is the first signal in the sidecar derived from actively exercising the
  pipeline rather than observing it: log parsing and probes can both report green
  while viewers receive nothing, and the canary is what catches that.

  New metrics (`scribear_canary_*`): run outcomes, time-to-first-transcript,
  word recall and precision, repetition ratio, pipeline and e2e latency
  percentiles, and clock-sync state. Two new alert rules — one for outright
  failure, one for degraded-but-flowing captions — plus C6 clock-sync detection.

  Disabled by default. It requires `CANARY_DEVICE_TOKEN`; without it the canary
  does not run. The device must belong to a dedicated canary room, since the
  canary streams synthetic speech into a real session. It deliberately holds no
  admin API key and no token-signing key, so it cannot reach any other room.

- 6f8e5b9: Add the standalone audio meter (Part A item A4) to the monitoring sidecar.

  The meter is a single self-contained HTML page — no imports, no build step and
  no network access of any kind. An audio engineer can copy it onto the source
  machine and open it straight from `file://`, which is the point: the whole
  value of A4 is being able to measure a room's input when the pipeline is the
  thing under suspicion. It picks up the same microphone the source browser
  would, and it uses an AudioWorklet where one is available, falling back to a
  `ScriptProcessorNode` when the blob worklet module is refused (as it is under
  `file://`), with identical readings either way.

  It reports RMS and fast RMS, sample peak with hold and decay, true (inter-
  sample) peak, clipping percentage, noise floor, a silence flag, and K-weighted
  loudness — momentary, short-term and gated integrated LUFS — plus short-term
  level against the loudness target in LU. Selectable conventions: dBFS reference
  (plain or AES17), loudness target, peak zone boundaries and silence threshold.
  SNR is deliberately absent; it needs voice-activity detection, which arrives
  with the service-side DSP work in Part B.

  The page's DSP is isolated in one DOM-free script block, and the unit suite
  extracts and evaluates that same block rather than a copy, so the shipped
  maths and the tested maths cannot drift. Gate A4 is verified end to end: a
  −18 dBFS alignment tone reads within ±0.5 dB on both audio paths.

  The sidecar also serves the page at `GET /api/monitoring/v1/audio-meter` as a
  convenience. That is a convenience only — the sidecar is not exposed through
  nginx, so reaching that URL from a source room needs a port-forward or an
  nginx rule. If the page file is missing the route is simply dropped with a
  warning rather than failing startup.

- 05a8b40: Source node-server telemetry from its status endpoint instead of its log text
  (monitoring plan B1.1, last of four PRs). This completes the cut-over: the log
  parsers for WebSocket closes, upstream state transitions, upstream churn and
  node-side decode drops are **removed**, and a new status poller feeds those same
  four metric names from `GET /api/node-server/v1/status`.

  Log inference worked, but it was lossy by construction — it depended on the log
  level, on the collector being attached for the whole window, and on nothing
  rotating out — and several signals had no log line at all. The endpoint also
  carries things logs never could: subscriber counts per session (nothing measured
  fan-out before), auth successes as the denominator that turns the S2 signal into
  a ratio, pending-chunk evictions, and the clock-skew discards behind S5.

  **Absolute totals, not increments.** The endpoint reports counters that are
  monotonic since node-server booted, so the poller tracks the previous absolute
  per series and applies only the difference. That keeps the sidecar's own
  counters monotonic and — importantly — keeps the rolling windows the alert rules
  evaluate against meaningful, which a plain `set()` would have destroyed.

  **Restarts rebase rather than diff.** A restarted node-server reports every
  counter back at zero. `processUid` changes on every boot, so a change clears the
  baselines and the fresh totals are attributed in full, since they are all events
  this sidecar has not seen. A counter that goes backwards without a uid change is
  treated the same way, so a restart between two polls can never produce a
  negative rate.

  **One metric got coarser, deliberately.** `scribear_node_upstream_churn_total`
  was per-session from logs; node-server counts it per process. The N1 rule now
  matches each series against its own labels and names the affected rooms from the
  new per-session upstream gauge instead. The trade is worth it: the counter is
  lossless where the log-derived one silently missed anything that happened while
  the collector was detached.

  **New alert for the blind spot this creates.** A node-server that is healthy but
  rejecting the sidecar's service key leaves four metrics reporting nothing while
  every probe stays green — a state the old log-based collector could not get
  into. `nodeStatusUnavailableRule` fires on that, critical when the key is
  rejected and warning when the endpoint is merely unreachable (which the probe
  poller already alerts on).

  The snapshot served to the admin SPA now includes a `gauges` block. Point-in-time
  values had nowhere to go before, and per-session state is exactly what the
  dashboard needs to draw a room rather than a number. Gauges for a session that
  ends are deleted rather than frozen at their last value — except when the
  response was truncated, where absence means "not told about" rather than
  "ended".

  Polling is disabled when `NODE_SERVER_SERVICE_API_KEY` is unset, matching how
  the canary treats its device token: a default deployment must not 401 against
  node-server on every interval forever. The startup log says so once, and the
  metrics it would have fed stay empty rather than wrong.

  transcription-service's decode-drop parser stays — that service has no status
  endpoint yet (B1.2), so its side of the metric is still only visible in logs.
  node-server's three A1 log lines also stay, as the per-event forensic record
  behind the counters.

- 1ad53e3: Delete Docker log ingestion entirely (B1.2 PR 5b).

  PR 5a retired the last five log parsers, leaving the ingest pipeline with one
  consumer: the session-manager config-poll correlator. Keeping the Docker Engine
  socket mount, the container discovery, the line normalizer and the correlator
  alive for a single detector was not a trade worth making, so all of it is gone.

  **The sidecar no longer needs the Docker socket.** That mount was
  root-equivalent access to the host. Every signal it fed now comes from an authed
  HTTP endpoint instead.

  **A real coverage regression, stated plainly.** Nothing now detects a
  `session-config-stream` 401 — the direct signature of the secret cross-wiring in
  ISSUES-To-Review.md. The N1 upstream churn it causes is still detected, so the
  symptom alerts, but the alert no longer names the cause. Restoring it needs a
  session-manager status endpoint, the same shape B1.1 and B1.2 gave node-server
  and transcription-service.

  Removed: the `configPollErrorRule` (N2/S3) and its `ALERT_CONFIG_POLL_ERROR_COUNT`
  threshold; the `scribear_sm_config_poll_*` and `scribear_log_lines_*` metrics;
  the snapshot's `ingest` block; and the `DOCKER_SOCKET_PATH` / `COMPOSE_PROJECT`
  env vars.

  **Readiness is re-keyed.** It required an ingested log line, which no longer
  exists. It now requires at least one probe result, and additionally reports
  unready when a status poll is being rejected with `unauthorized` or `not-found`
  — closing the follow-up B1.1 left open, where a sidecar whose status poll was
  refused reported ready while the metrics behind it silently froze. A merely
  unreachable service does not fail readiness; that is the monitored service's
  outage, not the sidecar's. The readiness `checks` key is renamed `logIngest` to
  `collectors`.

  > **Bump type note.** Recorded as `minor` rather than `major` because the
  > packages are pre-1.0, where the semver convention is that a minor bump
  > carries breaking changes and 1.0.0 is reserved for declaring the API
  > stable. Changesets does not apply that convention itself — a `major`
  > entry here would have taken every package straight to 1.0.0. The breaking
  > changes themselves are unchanged and are described above.

- 3b5ed13: Source transcription-service telemetry from `GET /metrics/status` instead of log text (B1.2 PR 5).

  `NodeStatusPollerService` is generalized into `AbsoluteStatusPoller`, which owns
  transport, bearer auth, the closed set of poll-error reasons, transition-only
  failure logging, `processUid` restart rebasing and the absolute-to-delta
  arithmetic. Subclasses supply only a body schema and a fold function.
  `TranscriptionMetricsPollerService` is the second consumer.

  This retires the last five log parsers: `pythonDecodeDropParser`,
  `createJobCompletionParser`, `bufferOverflowParser`, `audioTooFastParser` and
  `noSpeechParser`. Three of the counters behind them are incremented inside a
  spawned worker process, so logging them was the only reason they were ever
  visible.

  The T1 saturation rule now keys on **true RTF** — execution seconds per second
  of ingested audio, measured by transcription-service — rather than the
  period-utilization proxy. Period utilization survives as a secondary series,
  derived from the reported execution quantiles and `TRANSCRIPTION_JOB_PERIOD_MS`,
  so it no longer depends on a log line.

  **Breaking metric changes.** `scribear_node_status_up`,
  `scribear_node_status_poll_errors_total` and
  `scribear_node_process_restarts_total` are renamed to `scribear_service_*`, now
  that they carry a `service` label for more than one service.
  `scribear_asr_scheduling_delay_ms` and `scribear_asr_period_utilization` change
  from histograms to `quantile`-labelled gauges, and `scribear_asr_processing_ms`
  is replaced by `scribear_asr_execution_ms`; the endpoint reports pre-computed
  percentiles rather than samples, so there is no distribution to rebuild.
  `ALERT_PERIOD_UTILIZATION_P95` is renamed `ALERT_RTF_P95`.

  New env: `TRANSCRIPTION_SERVICE_METRICS_KEY`, `TRANSCRIPTION_METRICS_INTERVAL_SEC`.
  A key set on the sidecar but not on the service yields a 404, reported as the
  new `not-found` poll reason and alerted as a configuration fault rather than an
  outage.

- 4350c80: Alert on the two signals B1.1 started collecting but nothing evaluated, and fix
  the S2 denominator.

  `clockSkewRule` (§3 S5) fires when a large share of latency samples come back
  with a negative end-to-end time, meaning source clocks are ahead of
  node-server's despite sync. This is worth its own alert precisely because it is
  invisible otherwise: captions are unaffected and pipeline latency still reports,
  so the only symptom is an end-to-end panel that quietly stops being populated.
  It is a ratio with a minimum sample count, because a couple of odd devices are
  noise while a large fraction is a deployment fault.

  `pendingChunkEvictionRule` (§3 N3) fires when audio frames are evicted from the
  correlation map before their transcript returns. The captions are fine; what
  degrades is the latency measurement, and it degrades in the most misleading
  possible direction — the frames being dropped are the slow ones, so the
  remaining numbers look healthier than reality.

  `authFailureRule` now divides by auth _attempts_ rather than by all WebSocket
  closes. Attempts are what the plan specifies for S2, and they only became
  available with B1.1's status endpoint; dividing by every close includes normal
  end-of-session traffic, which drags the ratio down and can hide real signing-key
  drift entirely. The close-based form is kept as a fallback for deployments
  running without status polling, where it remains the only thing available.

  All three thresholds are configurable, as every threshold in this service is.

- d947523: Aggregate transcript latency server-side and report percentiles (B1.4).

  Node Server correlated every transcript back to the audio frame that produced
  it, published a `latencyUpdate` to whoever was subscribed, and then threw the
  number away. The only way to see a room's latency was to be a client watching
  that room, which is exactly the wrong property for an operations dashboard.

  `GET /api/node-server/v1/status` now carries bounded latency windows:
  - a process-wide `latency[]`, and a `latency[]` on each entry of `sessions[]`;
  - one series per `(measure, kind)` — `pipeline` (audio ingress to transcript,
    monotonic clock only) versus `e2e` (source capture to transcript, using the
    clock-corrected send time), each split into `final` and `inProgress`;
  - each series carries `count`/`sum` (lifetime, difference them like a counter)
    plus `sampleCount`/`min`/`max`/`mean`/`p50`/`p95`/`p99` over the retained ring
    (4096 process-wide, 512 per session).

  Interim and final transcripts are reported separately rather than pooled: a
  final is only emitted once the provider decides an utterance ended, so pooling
  would give a p50 describing interims and a p95 describing finals. A series with
  no samples is omitted rather than reported as zeroes — an `e2e` series is absent
  entirely when no source supplies a send timestamp, which is not the same as an
  end-to-end latency of zero. Percentiles are nearest-rank, matching what the
  sidecar and transcription-service already use.

  These are the first non-integer fields in the status response.

  Per-session windows are discarded when the session's last connection closes,
  the same lifetime as `subscriberCount`. A sample for a session with no recorded
  connection still counts process-wide but creates no per-session entry, so the
  map stays bounded by live rooms.

  The sidecar exports the process-wide figures as
  `scribear_node_pipeline_latency_ms` and `scribear_node_e2e_latency_ms`, labelled
  `kind` and `quantile` — gauges, not histograms, because Node Server reports
  pre-computed percentiles and observing a p95 into a local histogram would yield
  a distribution of p95s. Per-session percentiles are deliberately not mirrored
  into Prometheus; they would add a dozen series per live room to every scrape,
  and the fleet SPA can read them from `/status` directly.

## 0.1.0

### Minor Changes

- Initial monitoring sidecar implementing Part A items A1 (log-metrics
  collector) and A3 (probe & version poller) from
  `PLAN-MONITORING-DASHBOARD.md`.

  Parses the JSON logs of node-server, session-manager, admin-server, and
  transcription-service into counters and histograms; polls every service's
  liveness/readiness probes; evaluates the §3 failure-catalog alert rules
  in-process; and serves both a JSON snapshot for the admin SPA and a
  Prometheus text endpoint.

  All state is in memory — restarting the sidecar zeroes every metric, and
  historical trends are out of scope for this version.
