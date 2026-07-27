"""
Per-worker capacity estimator (PLAN-AdmissionControl.md §3)

Estimates how many concurrent sessions one worker can serve before it falls
behind, from nothing but the stream of completed job executions the pool
already reports to a JobObserver. Shadow mode: nothing in the live
connection/admission path calls this yet, so the decision logic can be written
and tested before it is ever allowed to refuse anyone.

Why per worker and not pool-wide: a pool can run several providers/contexts
across several workers, and one worker runs one job at a time, so N sessions
sharing a worker round-robin its single job loop. Averaging across workers
blends unrelated providers' per-pass costs into a number that describes no
worker in particular.

Why a measured cost instead of a configured session count: per-pass cost
depends on model, device, thread count and core count. The live CPU sweeps
behind this plan fit `service interval = N x C` to three significant figures
(23.0s/3 = 7.67, 45.9s/6 = 7.65) - C is real, measurable and device-specific,
and a hardcoded ceiling is a lossy encoding of it that is already wrong for
the shipped default template, let alone a different host.

CENSORSHIP REVIEW. This subsystem has twice shipped a guard whose own
measurement was corrupted by the failure it existed to catch, so every signal
this file derives is listed here with the direction it moves under the failure
it is meant to detect:

- `busy` is censored *upward* (it saturates at 1.0 while real cost keeps
  climbing). It is used only to *refuse* a window, so censorship makes the
  guard fire more readily, not less. Safe direction.
- `drop_share` rises under the same failure and is likewise only used to
  refuse a window. Safe direction.
- `cost_per_session` (`b`) is censored *downward* under saturation, which is
  the whole bug: `b = busy/N` stops rising once `busy` pegs, so a naive
  recompute raises the ceiling as the service collapses. Both gates above
  exist to stop `b` being learned from such a window at all.
- `clean_samples` is the one signal whose censorship is NOT in the safe
  direction, and it is a deliberate, spec'd choice rather than an oversight.
  It only advances on windows the gates accepted, so a worker that is
  degraded from its very first session never leaves warm-up, reports `None`
  forever, and therefore admits unconditionally forever. That is not
  hypothetical: `LESSONSLEARNED-AdmissionControl.md` measured 52.9% drop
  share at a *single* session on CPU with `vad_detector: true` - above
  ELEVATED_DROP_SHARE before a second session ever arrives. The plan's stated
  posture (an over-admission is visible and self-corrects; a wrong refusal is
  invisible) says permissive is the right default here, and substituting
  min_sessions would publish a fabricated ceiling in the same field a measured
  one uses. What makes it acceptable is that the state is *distinguishable*:
  a snapshot with `estimated_capacity_sessions is None` and a high `busy` or
  `drop_share` is a worker that never had a clean window, not an idle cold
  start, and those two fields are on WorkerCapacitySnapshot partly so an
  operator surface (§5) and step 5's shadow-mode validation can tell them
  apart before enforcement is ever switched on.
"""

import math
from collections import deque
from dataclasses import dataclass

from .job_result import DROPPED_PERIODS_COUNTER, JobExecutionObservation

NS_PER_SEC = 1000000000

# Default sliding window. Short enough that the estimate tracks a load change
# within a session or two of it happening, long enough to hold several passes
# of every job on the worker at the 30s ceiling `max_buffer_len_sec` puts on a
# job period.
DEFAULT_WINDOW_SEC = 60.0

# Passes discarded at the start of each job's history before it contributes
# anything to the window. The first passes through a fresh job pay one-off
# costs the steady state never pays again (model/context warm-up, a first-call
# differential inside the VAD path), so counting them inflates measured
# per-session cost and biases the ceiling *down* - the direction this plan
# explicitly does not want to err in, since a wrong refusal is invisible to
# everyone including us.
WARMUP_PASSES_DISCARDED = 3

# Clean samples a worker must accumulate before it reports a capacity at all.
# Below this the estimate is `None` ("unknown"), never a guess: the same rule
# §5 applies to a remote provider's capacity, which is reported as "not
# applicable" rather than as a fabricated number. A fake number here would be
# indistinguishable from a measured one at every consumer downstream.
#
# Counted only over windows the ratchet accepted, which means a worker that is
# never healthy never leaves warm-up - see the module docstring's censorship
# review, which is where that tradeoff is argued rather than assumed.
MIN_CLEAN_SAMPLES = 5

# Busy fraction at or above which a window is refused as a basis for `b`.
#
# THIS IS THE RATCHET, and it is not optional. Once a worker's busy fraction
# pegs near 1.0 the *measured* per-session cost stops rising while the real
# cost keeps rising, because the work that got dropped or skipped is not in
# the numerator. A naive recompute therefore *raises* the estimated ceiling
# exactly as the service collapses. This subsystem has already shipped that
# same shape twice (a tail-purge floor that climbed out of reach as drop share
# rose; a provider label that fell back to "unknown" most often during the
# outage it existed to name), so treat any measurement derived from a rate or
# a fraction as censored under the exact condition it is meant to detect.
BUSY_MEASUREMENT_CEILING = 0.9

# Drop share at or above which a window is refused as a basis for `b`, and
# above which the reported ceiling may only fall.
#
# Deliberately the same 0.5 the existing T1 saturation alert fires at, on the
# same underlying ratio (dropped_periods / (dropped_periods + passes)).
# Reusing a threshold that is already calibrated against live sweeps beats
# inventing a second number that would need its own justification and could
# drift away from the first.
ELEVATED_DROP_SHARE = 0.5

# A window holding a single pass has no idle time in it to observe - its span
# *is* that one execution - so it would read as 100% busy no matter how idle
# the worker really is. Busy is undefined below this, rather than reported as
# a saturated-looking 1.0 that the ratchet would then correctly but uselessly
# refuse forever.
MIN_PASSES_FOR_BUSY = 2


@dataclass(frozen=True)
class WorkerCapacitySnapshot:
    """
    Point-in-time capacity estimate for one worker

    Read-only and cheap, so it is safe to build from a request handler, in the
    same spirit as WorkerSnapshot.
    """

    worker_id: int
    # Echo of the live_job_count the caller passed in. Carried here so a
    # consumer rendering "N / N*" reads both halves off one object, without
    # this class ever having to track N itself and risk disagreeing with
    # WorkerSnapshot.live_job_count, which is the robust source for it.
    live_sessions: int
    # N*. None means "not measured yet", not "zero" and not "unlimited".
    estimated_capacity_sessions: int | None
    # Current window's busy fraction and drop share. Observability only - the
    # ratchet reads its own copies at record() time, so a consumer cannot
    # change a decision by choosing when to look.
    busy: float | None
    drop_share: float | None
    # The ratcheted `b`: per-session busy share from the last window clean
    # enough to trust. Held, deliberately stale, while the worker is degraded.
    cost_per_session: float | None


@dataclass
class _JobWarmUp:
    """
    Per-job pass bookkeeping used only to apply WARMUP_PASSES_DISCARDED
    """

    passes_seen: int
    last_complete_ns: int


@dataclass(frozen=True)
class _Pass:
    """
    One completed execution retained in a worker's window
    """

    job_id: int
    start_execute_ns: int
    complete_ns: int
    execution_ns: int
    dropped_periods: float


class _WorkerWindow:
    """
    Rolling window of completed passes for a single worker, plus the ratcheted
    state derived from it

    Self-contained on purpose: it shares no state with `_RollingUtilization`,
    which measures a continuous sequence of worker state transitions, whereas
    this is driven by discrete completed-job events that already carry their
    own timestamps.
    """

    @property
    def busy(self) -> float | None:
        """
        Fraction of the window's elapsed time the worker spent executing, or
        None while the window holds too few passes to say

        The denominator runs from the oldest retained pass's *start* (not its
        completion) to the newest completion, so every nanosecond in the
        numerator lies inside the span it is divided by. A worker runs one job
        at a time, so this cannot legitimately exceed 1; it is clamped anyway
        because a clock adjustment must not be able to manufacture a busy
        fraction the ratchet would then read as impossible.
        """
        if len(self._passes) < MIN_PASSES_FOR_BUSY:
            return None

        span_ns = self._newest_complete_ns - self._passes[0].start_execute_ns
        if span_ns <= 0:
            return None

        return min(1.0, self._execution_ns / span_ns)

    @property
    def drop_share(self) -> float | None:
        """
        Share of scheduled periods the worker never got to run, or None if the
        window is empty

        Exactly the ratio the existing T1 saturation alert keys on:
        dropped_periods / (dropped_periods + passes). Not re-derived from RTF,
        which moves the wrong way here - a dropped period leaves more audio for
        the next pass, so RTF *falls* as periods are lost.
        """
        passes = len(self._passes)
        if passes == 0:
            return None
        return self._dropped_periods / (self._dropped_periods + passes)

    def __init__(self, window_ns: int, target_busy: float):
        """
        Args:
            window_ns   - Length of the sliding window in nanoseconds
            target_busy - Headroom fraction the ceiling aims at
        """
        self._window_ns = window_ns
        self._target_busy = target_busy

        self._passes = deque[_Pass]()
        self._execution_ns = 0
        self._dropped_periods = 0.0
        self._newest_complete_ns = 0

        self._job_warm_up: dict[int, _JobWarmUp] = {}

        # Number of recorded passes that landed in a window the ratchet was
        # willing to learn from. Gates the warm-up "unknown" state.
        self.clean_samples = 0
        # Last trusted `b`, held across degraded windows.
        self.cost_per_session: float | None = None
        # Ratcheted N* before min/max are applied.
        self.ceiling: int | None = None

    def record(self, observation: JobExecutionObservation) -> None:
        """
        Folds one completed execution into the window and re-evaluates the
        ratchet

        Args:
            observation - A completed job execution reported by the pool
        """
        stats = observation.stats
        complete_ns = stats.complete_time_ns

        warm_up = self._job_warm_up.get(observation.job_id)
        if warm_up is None:
            warm_up = _JobWarmUp(passes_seen=0, last_complete_ns=complete_ns)
            self._job_warm_up[observation.job_id] = warm_up
        warm_up.passes_seen += 1
        warm_up.last_complete_ns = max(warm_up.last_complete_ns, complete_ns)

        if warm_up.passes_seen <= WARMUP_PASSES_DISCARDED:
            return

        # A failed pass is still counted. It occupied the worker for real
        # wall-clock time, and excluding failures would make the busy fraction
        # understate load precisely when a provider is failing repeatedly.
        self._append(
            _Pass(
                job_id=observation.job_id,
                start_execute_ns=stats.start_execute_time_ns,
                complete_ns=complete_ns,
                execution_ns=stats.execution_time_ns,
                dropped_periods=observation.counters.get(
                    DROPPED_PERIODS_COUNTER, 0.0
                ),
            )
        )
        self._update_ratchet()

    def _append(self, new_pass: _Pass) -> None:
        """
        Adds a pass and prunes everything that has fallen out of the window

        Args:
            new_pass    - The pass to retain

        "Now" is the newest completion this window has seen, never a wall-clock
        read. That keeps the window reproducible under test, and - more
        importantly - means a worker that stops completing work holds its last
        measurement instead of decaying to a healthy-looking idle. A window
        that aged itself out on a real clock would let a collapsed worker clear
        its own evidence by doing nothing, which is the same
        guard-erased-by-the-failure shape the busy ceiling above exists to
        avoid.
        """
        self._passes.append(new_pass)
        self._execution_ns += new_pass.execution_ns
        self._dropped_periods += new_pass.dropped_periods
        self._newest_complete_ns = max(
            self._newest_complete_ns, new_pass.complete_ns
        )

        cutoff_ns = self._newest_complete_ns - self._window_ns
        while self._passes and self._passes[0].complete_ns < cutoff_ns:
            expired = self._passes.popleft()
            self._execution_ns -= expired.execution_ns
            self._dropped_periods -= expired.dropped_periods

        # Bound the warm-up map by the same cutoff, so it cannot grow with the
        # number of sessions the process has ever served. A job whose last pass
        # is older than the whole window is either gone or running slower than
        # the 30s job-period ceiling allows; re-discarding its next few passes
        # if it does come back only costs samples, which is the safe direction.
        for job_id, warm_up in list(self._job_warm_up.items()):
            if warm_up.last_complete_ns < cutoff_ns:
                del self._job_warm_up[job_id]

    def _update_ratchet(self) -> None:
        """
        Re-derives `b` and the ceiling under the ratchet's two rules: learn
        only from a clean window, and never raise the ceiling from a dirty one
        """
        busy = self.busy
        drop_share = self.drop_share
        clean = (
            busy is not None
            and busy < BUSY_MEASUREMENT_CEILING
            and drop_share is not None
            and drop_share < ELEVATED_DROP_SHARE
        )

        if clean:
            self.clean_samples += 1
            sessions = len({retained.job_id for retained in self._passes})
            # Sessions measured from the window itself, not from the caller's
            # current live_job_count: `b` has to be paired with the
            # concurrency the busy fraction was actually observed at. Dividing
            # a stored busy fraction by a *later* N would make N* scale with
            # current load - N* ~ N always - and the gate would never close.
            #
            # Known bias: sessions that start and end inside one window are
            # counted as if they overlapped, which understates `b`. Sessions
            # here are lecture-length against a 60s window, so this is rare;
            # it is called out because it errs permissive.
            if sessions > 0 and busy is not None and busy > 0:
                self.cost_per_session = busy / sessions

        candidate = self._candidate_ceiling()
        if candidate is None:
            return

        if clean or self.ceiling is None:
            # Clean windows set the ceiling outright, up or down. The ratchet
            # must not be a one-way latch: an estimator that could only ever
            # fall would converge to the worst window it ever saw and stay
            # there long after the load causing it had gone.
            self.ceiling = candidate
        else:
            # Dirty window: lower freely, never raise. Redundant today - `b` is
            # frozen here, so `candidate` cannot have risen - and kept anyway,
            # because the invariant that has to hold is about the number this
            # class reports, not about how many paths currently write to `b`.
            # The next person to add a second writer should not have to
            # rediscover that.
            self.ceiling = min(self.ceiling, candidate)

    def _candidate_ceiling(self) -> int | None:
        """
        N* implied by the currently trusted `b`, before min/max are applied

        Returns:
            floor(target_busy / b), or None while no `b` has ever been trusted

        A zero or negative `b` is treated as no measurement rather than as
        infinite capacity: a window whose passes all took no measurable time
        says nothing about how many sessions the worker can carry.
        """
        if self.cost_per_session is None or self.cost_per_session <= 0:
            return None
        return math.floor(self._target_busy / self.cost_per_session)


class CapacityEstimator:
    """
    Estimates per-worker session capacity from completed job executions

    Usage
    ```
    estimator = CapacityEstimator(
        target_busy=0.85, min_sessions=1, max_sessions=None
    )

    # Wire as a JobObserver on the worker pool
    pool = WorkerPool(..., job_observer=estimator.record)

    # Read the estimate, supplying the worker's own live job count
    snapshot = estimator.snapshot(worker_id, worker.live_job_count)
    print(snapshot.estimated_capacity_sessions)  # N*, or None while unknown

    # Shadow-mode decision - not yet wired to any refusal
    if estimator.admit(worker_id, worker.live_job_count):
        ...
    ```
    """

    def __init__(
        self,
        target_busy: float,
        min_sessions: int,
        max_sessions: int | None,
        window_seconds: float = DEFAULT_WINDOW_SEC,
    ):
        """
        Args:
            target_busy     - Dimensionless headroom fraction the ceiling aims
                                at. Dimensionless is the whole point: it is the
                                same number on every device, because the
                                hardware-specific part is measured rather than
                                configured.
            min_sessions    - Floor under N*, so a mis-measurement can never
                                take a worker to zero admissions
            max_sessions    - Hard operator pin. When set, auto-tuning is off
                                and N* is exactly this.
            window_seconds  - Length of the sliding measurement window

        Reads no configuration and no environment of its own - every knob
        arrives as a primitive from the caller, so this stays unit-testable and
        the wiring layer owns where the defaults come from.
        """
        self._target_busy = target_busy
        self._min_sessions = min_sessions
        self._max_sessions = max_sessions
        self._window_ns = int(window_seconds * NS_PER_SEC)

        self._windows: dict[int, _WorkerWindow] = {}

    def record(self, observation: JobExecutionObservation) -> None:
        """
        Feeds one completed job execution into its worker's window

        Args:
            observation - A completed job execution, as delivered to a
                            JobObserver

        The only method with a side effect. Everything the ratchet decides is
        decided here, at the moment the evidence arrives, so a reader cannot
        move a decision by choosing when to call snapshot().
        """
        window = self._windows.get(observation.worker_id)
        if window is None:
            window = _WorkerWindow(self._window_ns, self._target_busy)
            self._windows[observation.worker_id] = window
        window.record(observation)

    def snapshot(
        self, worker_id: int, live_job_count: int
    ) -> WorkerCapacitySnapshot:
        """
        Gets the current estimate for one worker

        Args:
            worker_id       - Worker to report on
            live_job_count  - N, the worker's current live job count

        Returns:
            A point-in-time view; estimated_capacity_sessions is None while the
            worker is still warming up

        Side effect free, including for a worker_id that has never been seen -
        an unknown worker reads as warm-up, and asking about it does not create
        it. Warm-up and unknown are the same state on purpose: both mean "no
        measurement", and a caller that had to distinguish them would end up
        encoding pool topology it has no business knowing.

        N is supplied rather than tracked here because
        WorkerSnapshot.live_job_count is already the robust source for it; a
        second copy would eventually disagree with the first.
        """
        window = self._windows.get(worker_id)
        return WorkerCapacitySnapshot(
            worker_id=worker_id,
            live_sessions=live_job_count,
            estimated_capacity_sessions=self._capacity(window),
            busy=window.busy if window else None,
            drop_share=window.drop_share if window else None,
            cost_per_session=window.cost_per_session if window else None,
        )

    def admit(self, worker_id: int, live_job_count: int) -> bool:
        """
        Whether one more session may be placed on this worker

        Args:
            worker_id       - Worker the session would be placed on
            live_job_count  - N, the worker's current live job count

        Returns:
            True if the session should be admitted

        `admit <=> N == 0 or N + 1 <= N*`. Both escape hatches lean permissive,
        which is this plan's stated posture: an over-admission is visible,
        counted and self-corrects, while a wrong refusal is invisible and
        unrecoverable for that user.

        - N == 0 admits unconditionally. There is nothing to be too busy with,
          and the common cold-start case must never wait on a measurement.
        - An unknown N* admits. The alternative - substituting min_sessions, or
          any other number - would make a guess indistinguishable from a
          measurement at exactly the moment there is no measurement.
        """
        if live_job_count <= 0:
            return True

        capacity = self._capacity(self._windows.get(worker_id))
        if capacity is None:
            return True

        return live_job_count + 1 <= capacity

    def _capacity(self, window: _WorkerWindow | None) -> int | None:
        """
        Applies the operator overrides to a worker's ratcheted ceiling

        Args:
            window  - The worker's window, or None if it has never been seen

        Returns:
            N*, or None while the worker is warming up

        Order matters and is easy to get backwards:

        1. A `max_sessions` pin wins over everything, including warm-up. It is
           an operator statement about the deployment, not an estimate, so it
           is available from the first request rather than after a measurement
           the operator has already overruled.
        2. Warm-up wins over `min_sessions`. The floor exists so a *bad*
           measurement cannot take a worker to zero; using it as a stand-in for
           *no* measurement would publish a fabricated ceiling under the same
           field name a measured one uses.
        3. Only then does the floor apply - to a real measurement, including a
           deliberately stale one the ratchet is holding.
        """
        if self._max_sessions is not None:
            return self._max_sessions

        if window is None or window.clean_samples < MIN_CLEAN_SAMPLES:
            return None

        if window.ceiling is None:
            return self._min_sessions

        return max(window.ceiling, self._min_sessions)
