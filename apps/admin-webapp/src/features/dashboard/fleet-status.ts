import { useMemo } from 'react';

import type {
  AudioLevelStats,
  AudioStage,
  FleetSnapshot,
  MergedProvider,
  SessionAudioSnapshot,
  SessionSnapshot,
  SessionStatusEvent,
  VadStats,
} from '#src/lib/admin-api';

/**
 * `SessionSnapshot.roomUid` is opaque telemetry, not a link to room-management
 * data (`PLAN-fleet-and-testaudio.md` §B.4's `RoomTelemetry` grouping predates
 * the real B1.7 schema and doesn't exist on the wire). The grid below is
 * therefore still session-centric: one card per `sessionUid`, not per room -
 * `roomUid` is surfaced and searchable on the card, not used to group it.
 */
export type FleetStatus = 'good' | 'warn' | 'crit' | 'idle';

const RANK: Record<FleetStatus, number> = {
  crit: 0,
  warn: 1,
  good: 2,
  idle: 3,
};

/**
 * No writer publishes a canonical per-session status today, so this derives
 * one from the upstream connection state, refined by the live `/fleet/stream`
 * connectivity event when one has arrived for this session (it is more
 * current than the state baked into the last `/fleet` snapshot).
 */
export function deriveSessionStatus(
  session: SessionSnapshot,
  event: SessionStatusEvent | undefined,
): FleetStatus {
  if (
    event &&
    (!event.sourceDeviceConnected || !event.transcriptionServiceConnected)
  ) {
    return 'crit';
  }
  switch (session.upstreamState) {
    case 'OPEN':
      return 'good';
    case 'WAITING_RETRY':
    case 'CONNECTING':
    case 'HANDSHAKING':
      return 'warn';
    case 'CLOSED':
      return 'crit';
    case 'IDLE':
    default:
      return 'idle';
  }
}

/** `p95` of the final pipeline-latency series, or `null` if none has landed yet. */
export function pipelineP95(session: SessionSnapshot): number | null {
  const series = session.latency.find(
    (l) => l.measure === 'pipeline' && l.kind === 'final',
  );
  return series && series.count > 0 ? series.p95 : null;
}

// ---- Audio status (D1: a second, independent axis, not a refinement of the
// connectivity status above) ----

export type AudioStatus = 'good' | 'warn' | 'crit' | 'unknown';

/** The MUI palette keys the status chips use. */
export type StatusColor = 'success' | 'warning' | 'error' | 'default';

/**
 * Chip colour per audio status. Exported so every surface that renders an audio
 * status — the fleet card, the filter chips, the roll-up, the session detail
 * header — reads from one table. `unknown` is deliberately `default` (grey), not
 * a warning colour: "no reading" is not the same claim as "bad reading".
 *
 * Colour never carries the status alone; every chip renders the status word too
 * (SC 1.4.1).
 */
export const AUDIO_STATUS_COLOR: Record<AudioStatus, StatusColor> = {
  good: 'success',
  warn: 'warning',
  crit: 'error',
  unknown: 'default',
};

/**
 * Thresholds for `deriveAudioStatus`. Each number's provenance is noted so the
 * later per-room baseline work (D3 of PLAN-AUDIOVIZ) has one place to replace.
 *
 * The clipping threshold (1 % of samples) and the silence flag come straight
 * from the publisher's `AudioLevelStats`. `rmsDbfsHigh` (-6 dBFS) is the
 * standalone meter's default peak-zone crit boundary (`audio-meter.html`'s
 * "Peak zones" control); `rmsDbfsLow` (-50 dBFS) is *not* from the standalone
 * meter — it sits between its -60 dBFS floor and its -40 dBFS scale step, i.e.
 * low enough that a working room mic never reads there. The SNR threshold
 * (10 dB) is the point below which speech intelligibility degrades measurably.
 * These are first-cut constants, not tuned values — see
 * PLAN-MONITORING-DASHBOARD.md §59 on per-room baselines.
 */
export const AUDIO_THRESHOLDS = {
  /**
   * Fraction (0..1) of clipped samples above which the session is crit, i.e.
   * 1 % of samples. Compared against `clippingPct`, which the publisher emits
   * as a fraction, *not* as a percentage — use `formatClippingPct` to render it.
   *
   * 1 % matches the point at which the standalone meter page announces
   * "Clipping detected. Reduce input gain." (`audio-meter.html`), so the two
   * surfaces escalate together. It counts only runs at the rail, so a source
   * that merely touches full scale never reaches it.
   */
  clippingPctCrit: 0.01,
  /** RMS below this is very low — likely a muted or far mic. */
  rmsDbfsLow: -50,
  /** RMS above this is hot — approaching clipping. */
  rmsDbfsHigh: -6,
  /** SNR below this (when VAD measured it) means poor signal-to-noise. */
  snrDbPoor: 10,
  /**
   * Seconds of difference across a stage edge below which no signal loss is
   * reported (§12.6).
   *
   * A naive `upstream - downstream > 0` check would flag every healthy session.
   * The two counters in one snapshot are read at different instants: ingress is
   * sampled on the webserver at publish time, while a worker's counter only
   * advances when a job runs, so at any instant a *perfectly healthy* pipeline
   * has up to one job period of audio received-but-not-yet-decoded. 5 s is the
   * largest `job_period_ms` the shipped provider configs use
   * (`deployment/provider_config.template.json`: 5000 for whisper and debug,
   * 3000 for lumen_granite), expressed in seconds.
   *
   * First-cut, like every constant above it: it is a bound on the *shipped*
   * configuration, not a measured standing skew, and a deployment that raises
   * `job_period_ms` past 5 s will see spurious loss on its `ingress` →
   * `asr_input` edge until this follows it. Deliberately generous rather than
   * tight — a false "audio is being lost" claim sends an operator to look for a
   * fault that does not exist, which is the failure mode §12.1 exists to stop.
   */
  signalLossToleranceSec: 5,
} as const;

// ---- Stage graph (§12.2/§12.6) ----

/**
 * A stage that is known to carry levels / a detector.
 *
 * The narrowing is in the type rather than re-checked at every use site because
 * `levels: null` and `vad: null` are *frequent* — most stages in the shipped
 * graph have one of them null — so a caller that has already selected a metered
 * stage should not have to prove it again, and a `!` or a `?? 0` at the point of
 * rendering a dBFS figure is how a "not measured" becomes a displayed zero.
 */
export type MeteredStage = AudioStage & { levels: AudioLevelStats };
/** @see {@link MeteredStage} */
export type DetectorStage = AudioStage & { vad: VadStats };

function isMetered(stage: AudioStage): stage is MeteredStage {
  return stage.levels !== null;
}

function isDetector(stage: AudioStage): stage is DetectorStage {
  return stage.vad !== null;
}

/**
 * The stage that drives every audio status and chip: the **lowest-`depth` stage
 * carrying `levels`**.
 *
 * That is the measurement closest to the source, so it is the one that answers
 * failure mode C1 — "no audio reaching ASR" / mic muted, unplugged, or wrong
 * input. A deeper stage's levels are downstream of anything the pipeline itself
 * did to the audio, so classifying on those conflates a bad room with a broken
 * worker; §12.8 point 1 is explicit that the audio axis now asserts only "the
 * source is sending good audio", with pipeline faults showing on the
 * connectivity chip and in the per-edge `audioSeconds` gap instead (D1).
 *
 * Exported because several surfaces need it — the card strip, the roll-up, the
 * filter facet, the detail page — and they must not each pick differently: two
 * surfaces disagreeing about which reading is "the" reading is exactly the class
 * of defect `PEAK_CONVENTION` and `formatClippingPct` already exist to prevent.
 *
 * Returns `undefined` when no stage reports levels at all. That is a real state
 * (a `debug`-provider session reports throughput only), not an error — see
 * `classifyAudioSnapshot`. Ties at the same depth resolve by stage id so the
 * answer is deterministic across renders; a graph with two metering sources at
 * depth 1 has two equally valid answers to C1, and picking a stable one beats
 * picking whichever the publisher happened to serialise first.
 */
export function headlineStage(
  audio: SessionAudioSnapshot,
): MeteredStage | undefined {
  let best: MeteredStage | undefined;
  for (const stage of audio.stages) {
    if (!isMetered(stage)) continue;
    if (
      best === undefined ||
      stage.depth < best.depth ||
      (stage.depth === best.depth && stage.stage < best.stage)
    ) {
      best = stage;
    }
  }
  return best;
}

/**
 * The stage whose VAD statistics the surfaces render — the lowest-`depth` stage
 * carrying a `vad` (§12.6: "VAD rendering reads the `vad` of whichever stage
 * carries one").
 *
 * Separate from `headlineStage` because the two are *never* the same point in
 * the shipped graph: a detector reports `vad` and no `levels`, while the metering
 * points report `levels` and no `vad`. Same lowest-depth, stable-tie rule, for
 * the same reason.
 */
export function vadStage(
  audio: SessionAudioSnapshot,
): DetectorStage | undefined {
  let best: DetectorStage | undefined;
  for (const stage of audio.stages) {
    if (!isDetector(stage)) continue;
    if (
      best === undefined ||
      stage.depth < best.depth ||
      (stage.depth === best.depth && stage.stage < best.stage)
    ) {
      best = stage;
    }
  }
  return best;
}

/** Convenience for the surfaces that only want the VAD numbers themselves. */
export function headlineVadStats(audio: SessionAudioSnapshot): VadStats | null {
  return vadStage(audio)?.vad ?? null;
}

/**
 * Stages grouped by `depth`, ascending, with stages inside a group ordered by
 * stage id.
 *
 * Ordering is imposed here rather than trusted from the wire: `stages` arrives
 * in whatever order the publisher serialised it, and a table whose rows reorder
 * between two polls of the same unchanged pipeline is unreadable.
 */
export function stagesByDepth(
  audio: SessionAudioSnapshot,
): { depth: number; stages: AudioStage[] }[] {
  const groups = new Map<number, AudioStage[]>();
  for (const stage of audio.stages) {
    const existing = groups.get(stage.depth);
    if (existing === undefined) {
      groups.set(stage.depth, [stage]);
    } else {
      existing.push(stage);
    }
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a - b)
    .map(([depth, stages]) => ({
      depth,
      stages: [...stages].sort((a, b) => a.stage.localeCompare(b.stage)),
    }));
}

/**
 * Cumulative seconds counted at the most source-proximate point that counts at
 * all, or `null` when no stage reports `audioSeconds`.
 *
 * The card strip uses this in the metering-unavailable state: a provider that
 * meters nothing still proves audio is *flowing*, and "no levels" plus a
 * climbing second count is a materially different situation from "no levels and
 * nothing arriving". Deliberately the lowest-depth counter rather than the
 * largest number, because a deeper stage's total is downstream of any loss.
 */
export function sourceThroughputSeconds(
  audio: SessionAudioSnapshot,
): number | null {
  for (const group of stagesByDepth(audio)) {
    for (const stage of group.stages) {
      if (stage.audioSeconds !== null) return stage.audioSeconds;
    }
  }
  return null;
}

/**
 * What one edge of the stage graph says about the audio crossing it.
 *
 * - `within-tolerance` — the two counters differ by less than
 *   `AUDIO_THRESHOLDS.signalLossToleranceSec`, i.e. by no more than the standing
 *   skew a healthy pipeline has. Also covers a negative difference (downstream
 *   ahead of upstream), which is meaningless rather than alarming.
 * - `gated` — the downstream point runs a detector, so it is *supposed* to pass
 *   on less than it received. Reporting that as loss would put a large red
 *   number on every VAD-enabled session: the shipped whisper graph passes ~47 s
 *   of speech out of ~123 s of audio (§12.4's example payload) and that is the
 *   detector working. The figure is still worth showing — §12.3 wants the gap
 *   above a VAD stage read as "over-aggressive gating; a detector eating the
 *   room" — but it is a different claim from "the pipeline dropped audio".
 * - `loss` — both ends count, neither gates, and the gap exceeds tolerance.
 *   This is the reading the whole stage graph exists to produce: audio the
 *   pipeline itself lost, attributed to the edge that lost it.
 */
export type StageEdgeKind = 'within-tolerance' | 'gated' | 'loss';

/** One derivable edge of the stage graph, with its `audioSeconds` comparison. */
export interface StageEdge {
  /** Upstream stage id and label. */
  fromStage: string;
  fromLabel: string;
  /** Downstream stage id and label. */
  toStage: string;
  toLabel: string;
  upstreamSeconds: number;
  downstreamSeconds: number;
  /** `upstreamSeconds - downstreamSeconds`. Negative is possible and benign. */
  differenceSeconds: number;
  kind: StageEdgeKind;
}

/**
 * Compares `audioSeconds` across every edge of the stage graph — the derivation
 * that makes the graph worth having, because it answers "where did the audio get
 * lost" rather than "is the audio bad" (§12.6).
 *
 * Only edges where **both** ends report a number are returned. A missing counter
 * makes the subtraction undefined, and an undefined subtraction rendered as
 * `0 s lost` would be a claim the data does not support; the detail page shows
 * such an edge as not derivable instead. An `inputs` entry naming a stage absent
 * from this snapshot is skipped for the same reason (§12.2 allows it: the
 * upstream point reported nothing this batch).
 *
 * Edges come back in the stage order `stagesByDepth` imposes, so the first
 * flagged edge is the earliest point in the pipeline that lost audio — which is
 * the one an operator should look at, since everything below it inherits the
 * shortfall.
 */
export function deriveStageEdges(audio: SessionAudioSnapshot): StageEdge[] {
  const byId = new Map(audio.stages.map((s) => [s.stage, s]));
  const edges: StageEdge[] = [];
  for (const group of stagesByDepth(audio)) {
    for (const downstream of group.stages) {
      for (const inputId of downstream.inputs) {
        const upstream = byId.get(inputId);
        if (upstream === undefined) continue;
        if (
          upstream.audioSeconds === null ||
          downstream.audioSeconds === null
        ) {
          continue;
        }
        const differenceSeconds =
          upstream.audioSeconds - downstream.audioSeconds;
        const kind: StageEdgeKind =
          downstream.vad !== null
            ? 'gated'
            : differenceSeconds > AUDIO_THRESHOLDS.signalLossToleranceSec
              ? 'loss'
              : 'within-tolerance';
        edges.push({
          fromStage: upstream.stage,
          fromLabel: upstream.label,
          toStage: downstream.stage,
          toLabel: downstream.label,
          upstreamSeconds: upstream.audioSeconds,
          downstreamSeconds: downstream.audioSeconds,
          differenceSeconds,
          kind,
        });
      }
    }
  }
  return edges;
}

/**
 * The edges that are genuinely losing audio — `deriveStageEdges` filtered to
 * `kind === 'loss'`.
 *
 * A convenience rather than a second derivation, so no surface can accidentally
 * count gated edges as faults.
 */
export function signalLossEdges(audio: SessionAudioSnapshot): StageEdge[] {
  return deriveStageEdges(audio).filter((edge) => edge.kind === 'loss');
}

/**
 * Renders `AudioLevelStats.clippingPct` as a percentage for display.
 *
 * The field is a **fraction** (0..1) — the share of the window at the rail in
 * runs, per `audio_meter.py` — so it has to be scaled by 100 before a `%`
 * suffix. Shared by the session card and the session detail page so the two
 * surfaces cannot disagree about the units (D4: one instrument, not two
 * dialects).
 *
 * Values below 0.01 % are rendered as `<0.01%` rather than rounding to a flat
 * `0.00%`, which would claim "no clipping" on a chip that is only shown because
 * clipping is nonzero.
 */
export function formatClippingPct(clippingPct: number): string {
  const pct = clippingPct * 100;
  if (pct > 0 && pct < 0.01) return '<0.01%';
  return `${pct.toFixed(2)}%`;
}

/**
 * Derives an audio status from a session's latest audio snapshot.
 *
 * `unknown` when no snapshot exists; for a live (`OPEN`) session that is
 * itself a finding — see D2 of PLAN-AUDIOVIZ: "no audio reaching ASR" is
 * failure mode C1 (mic muted / unplugged / wrong input).
 *
 * Classification reads the **headline stage** — the lowest-depth stage carrying
 * levels (§12.6, see `headlineStage`) — so a green chip asserts "the source is
 * sending good audio" and nothing more (§12.8 point 1).
 *
 * Rules (all constants from `AUDIO_THRESHOLDS`):
 *
 * | Condition | Status |
 * |---|---|
 * | no snapshot **and** `upstreamState === 'OPEN'` | `crit` — "no audio reaching ASR" (C1) |
 * | no snapshot, session not open | `unknown` |
 * | snapshot exists, no stage reports `levels` | `unknown` — throughput-only provider, no level reading to judge |
 * | `silence === true` | `crit` — digital silence on a live session |
 * | `clippingPct > 0.01` | `crit` — clipping |
 * | `rmsDbfs < -50` | `warn` — very low level |
 * | `rmsDbfs > -6` | `warn` — hot |
 * | `vadEnabled && snrDb !== null && snrDb < 10` | `warn` — poor SNR |
 * | otherwise | `good` |
 */
export function deriveAudioStatus(
  audio: SessionAudioSnapshot | undefined,
  session: SessionSnapshot,
): AudioStatus {
  if (audio === undefined) {
    return session.upstreamState === 'OPEN' ? 'crit' : 'unknown';
  }
  return classifyAudioSnapshot(audio);
}

/**
 * Classifies an existing audio snapshot into a status, without the "no
 * snapshot" path that `deriveAudioStatus` handles. Used by the session detail
 * page, which already knows a snapshot exists and has no `SessionSnapshot` to
 * pass (its session comes from session-manager, not fleet telemetry).
 *
 * **A snapshot whose stages carry no `levels` anywhere is `unknown`.** This is a
 * real state since §12: the `debug` provider reports `asr_input` with
 * `levels: null` and seconds only, and a deployment can legitimately meter
 * nothing while still publishing throughput. Neither of the two obvious answers
 * is honest:
 *
 * - `good` would be a **false green** — the strongest claim this axis can make,
 *   asserted from zero level measurements. It would also silently restore the
 *   §12.1 bug in mirror image: instead of every healthy `debug` session showing
 *   red, every *broken* one would show green.
 * - `crit` would be a **false fault** — precisely the alarm §12 was written to
 *   remove. The session is publishing telemetry, so something is decoding its
 *   audio; the pipeline is demonstrably alive, and sending an operator to check
 *   a microphone would be wrong.
 * - `warn` would still be a claim about the audio, and there is no reading to
 *   make it from — it would put an amber chip on a fleet that is fine.
 *
 * `unknown` is the only status that says what is actually true: no reading. Its
 * chip colour is already deliberately grey rather than a warning colour, for
 * exactly this distinction (see `AUDIO_STATUS_COLOR`), and the surfaces pair it
 * with copy naming the reason — "metering unavailable for this provider" — so it
 * cannot be misread as "no audio" (§12.8 point 1). It also groups correctly under
 * the existing `audio: unknown` filter facet, which already means "no reading".
 */
export function classifyAudioSnapshot(
  audio: SessionAudioSnapshot,
): AudioStatus {
  const levels = headlineStage(audio)?.levels;
  if (levels === undefined) return 'unknown';

  if (levels.silence) return 'crit';
  if (levels.clippingPct > AUDIO_THRESHOLDS.clippingPctCrit) return 'crit';
  if (levels.rmsDbfs < AUDIO_THRESHOLDS.rmsDbfsLow) return 'warn';
  if (levels.rmsDbfs > AUDIO_THRESHOLDS.rmsDbfsHigh) return 'warn';

  const vad = headlineVadStats(audio);
  if (
    vad !== null &&
    vad.vadEnabled &&
    vad.snrDb !== null &&
    vad.snrDb < AUDIO_THRESHOLDS.snrDbPoor
  ) {
    return 'warn';
  }

  return 'good';
}

/**
 * Indexes `sessionAudio` by `sessionUid` for O(1) lookup per session card.
 * Returns an empty map when the snapshot is null (telemetry unavailable).
 */
export function audioBySession(
  snapshot: FleetSnapshot | null,
): Map<string, SessionAudioSnapshot> {
  const map = new Map<string, SessionAudioSnapshot>();
  if (snapshot === null) return map;
  for (const audio of snapshot.sessionAudio) {
    map.set(audio.sessionUid, audio);
  }
  return map;
}

export interface FleetFilter {
  status?: FleetStatus[];
  providerKey?: string;
  text?: string;
  /** Audio-status facet — `unknown` covers sessions with no audio snapshot. */
  audioStatus?: AudioStatus[];
}

/**
 * `exactOptionalPropertyTypes` forbids assigning `providerKey: undefined`
 * directly in an object literal, so clearing the filter needs an explicit
 * key-drop rather than a spread with an undefined value.
 */
export function setProviderKey(
  filter: FleetFilter,
  providerKey: string | undefined,
): FleetFilter {
  if (providerKey === undefined) {
    const next: FleetFilter = {};
    if (filter.status !== undefined) next.status = filter.status;
    if (filter.text !== undefined) next.text = filter.text;
    if (filter.audioStatus !== undefined) next.audioStatus = filter.audioStatus;
    return next;
  }
  return { ...filter, providerKey };
}

export interface FleetRow {
  session: SessionSnapshot;
  status: FleetStatus;
  event: SessionStatusEvent | undefined;
  audio: SessionAudioSnapshot | undefined;
  audioStatus: AudioStatus;
}

export function useFilteredSessions(
  sessions: SessionSnapshot[],
  sessionEvents: Map<string, SessionStatusEvent>,
  audioBySession: Map<string, SessionAudioSnapshot>,
  filter: FleetFilter,
): FleetRow[] {
  return useMemo(() => {
    const t = filter.text?.trim().toLowerCase();
    const rows: FleetRow[] = sessions.map((session) => {
      const event = sessionEvents.get(session.sessionUid);
      const audio = audioBySession.get(session.sessionUid);
      return {
        session,
        status: deriveSessionStatus(session, event),
        event,
        audio,
        audioStatus: deriveAudioStatus(audio, session),
      };
    });
    return rows
      .filter(
        (r) =>
          (!filter.status?.length || filter.status.includes(r.status)) &&
          (!filter.providerKey ||
            r.session.providerKey === filter.providerKey) &&
          (!filter.audioStatus?.length ||
            filter.audioStatus.includes(r.audioStatus)) &&
          (!t ||
            r.session.sessionUid.toLowerCase().includes(t) ||
            (r.session.roomUid?.toLowerCase().includes(t) ?? false)),
      )
      .sort(
        (a, b) =>
          RANK[a.status] - RANK[b.status] ||
          (pipelineP95(b.session) ?? 0) - (pipelineP95(a.session) ?? 0),
      );
  }, [
    sessions,
    sessionEvents,
    audioBySession,
    filter.status,
    filter.providerKey,
    filter.audioStatus,
    filter.text,
  ]);
}

// ---- Provider capacity (PLAN-AdmissionControl.md §5) ----

export type CapacityStatus = 'good' | 'warn' | 'crit' | 'unknown';

/**
 * Chip/bar colour per capacity status, same table shape as
 * `AUDIO_STATUS_COLOR`. `unknown` is `default` (grey) for the same reason:
 * "not measured yet" is not the same claim as "bad".
 */
export const CAPACITY_STATUS_COLOR: Record<CapacityStatus, StatusColor> = {
  good: 'success',
  warn: 'warning',
  crit: 'error',
  unknown: 'default',
};

/**
 * `live / estimated` at or above this ratio is `warn` ("near the ceiling").
 * Deliberately the estimator's own `TARGET_BUSY` default
 * (`transcription_service`'s `CapacityEstimator`, PLAN-AdmissionControl.md
 * §3): N* is already sized so that admitting up to it keeps busy fraction
 * near `TARGET_BUSY`, so a live count approaching N* is the UI's own signal
 * that the worker is approaching the same headroom boundary the estimator
 * was tuned around — not a second, independently-chosen number.
 */
export const CAPACITY_WARN_RATIO = 0.85;

/**
 * One provider's capacity reading, aggregated across every host and worker
 * serving it.
 */
export interface ProviderCapacity {
  /**
   * `false` for a non-`local` provider (`remote`, `debug`, `unknown`) — a
   * remote API's capacity question is upstream rate limits, not a local
   * worker pool (PLAN-AdmissionControl.md §5), and is explicitly out of scope
   * for this readout. Taken from the first reporting host's `kind`: a
   * `providerKey` names one implementation, so every host reporting it is
   * expected to agree.
   */
  applicable: boolean;
  /** Current session count, summed across every host serving this provider. */
  liveSessions: number;
  /**
   * Sum of `estimatedCapacitySessions` across every worker that owns this
   * provider, across every host. `null` when there is no owning worker to ask
   * (an unroutable provider, B1.7) or when *any* owning worker has not
   * produced a real measurement yet — summing a real number with a
   * placeholder zero for the unmeasured one would understate the true
   * ceiling, so the whole aggregate stays "not measured" rather than
   * partially fabricated.
   */
  estimatedCapacitySessions: number | null;
}

/**
 * Aggregates one merged provider's owning workers into a single capacity
 * reading, the same join `ProviderHealthSnapshotService` already performs
 * per host — this only sums it across hosts.
 */
export function deriveProviderCapacity(
  provider: MergedProvider,
): ProviderCapacity {
  const kind = provider.hosts[0]?.health.kind ?? 'unknown';
  const workers = provider.hosts.flatMap((host) => host.health.owningWorkers);
  const estimatedCapacitySessions =
    workers.length > 0 &&
    workers.every((worker) => worker.estimatedCapacitySessions !== null)
      ? workers.reduce(
          (sum, worker) => sum + (worker.estimatedCapacitySessions ?? 0),
          0,
        )
      : null;

  return {
    applicable: kind === 'local',
    liveSessions: provider.activeSessions,
    estimatedCapacitySessions,
  };
}

/**
 * `unknown` when capacity has not been measured yet (never a fabricated
 * `good`/`crit`); `crit` only when live sessions exceed the estimate, which
 * `CapacityEstimator.admit()` should never let happen — rendered anyway
 * (PLAN-AdmissionControl.md §5: "render sanely if it does") rather than
 * assumed impossible on a UI that must survive its own assumptions being
 * wrong.
 */
export function deriveCapacityStatus(
  capacity: ProviderCapacity,
): CapacityStatus {
  const { liveSessions, estimatedCapacitySessions } = capacity;
  if (estimatedCapacitySessions === null) return 'unknown';
  if (liveSessions > estimatedCapacitySessions) return 'crit';
  if (
    estimatedCapacitySessions > 0 &&
    liveSessions / estimatedCapacitySessions >= CAPACITY_WARN_RATIO
  ) {
    return 'warn';
  }
  return 'good';
}
