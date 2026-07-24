import type { TranscriptFragment } from '@scribear/node-server-schema';

import type { DemoRoomConfig } from '#src/app-config/app-config.js';
import type { AppDependencies } from '#src/server/dependency-injection/app-dependencies.js';
import { SessionStatusChannel } from '#src/server/features/transcription-stream/events/session-status.events.js';
import {
  TranscriptChannel,
  type TranscriptMessage,
} from '#src/server/features/transcription-stream/events/transcript.events.js';

import {
  DEMO_LOOP_TAIL_GAP_MS,
  DEMO_SPEAKER_LABELS,
} from './demo-room.constants.js';
// The fixture is inlined into the bundle by esbuild at build time (only
// `dist/bundle.mjs` ships), so no file is read at runtime. Source & licence:
// Alice's Adventures in Wonderland, Chapter V, Project Gutenberg eBook #11
// (public domain). See the fixture's `source` block and PLAN-Demo-CAPTION_ROOM.md.
import demoFixture from './fixtures/alice-chapter-v.utterances.json' with { type: 'json' };

/** One utterance from the fixture (the fields the emitter reads). */
interface DemoUtterance {
  start: number;
  end: number;
  speaker: string;
  spoken: string;
  progresstxt: string;
}

/** A single caption publish scheduled at `atMs` on the loop's virtual clock. */
interface ScheduledEvent {
  atMs: number;
  message: TranscriptMessage;
}

const UTTERANCES =
  demoFixture.utterances as unknown as readonly DemoUtterance[];

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Display label for a speaker, capitalized as a fallback for unknown names. */
function speakerLabel(speaker: string): string {
  return (
    DEMO_SPEAKER_LABELS[speaker] ??
    speaker.charAt(0).toUpperCase() + speaker.slice(1)
  );
}

/**
 * Turn one utterance's text into a wire {@link TranscriptFragment}: word tokens
 * (each carrying its leading space, so `text.join('')` reconstructs the string)
 * with per-token times spread evenly across `[startS, endS]`.
 *
 * On the first fragment of a speaker turn the speaker label is folded into the
 * leading token (`"Caterpillar: "`), because the wire schema carries no speaker
 * field - a demo-only convention documented in PLAN-Demo-CAPTION_ROOM.md.
 */
export function buildFragment(
  text: string,
  speaker: string,
  turnStart: boolean,
  startS: number,
  endS: number,
): TranscriptFragment {
  const display = turnStart ? `${speakerLabel(speaker)}: ${text}` : text;
  const words = display.split(/\s+/).filter((word) => word.length > 0);
  const tokens = words.map((word, index) => (index === 0 ? word : ` ${word}`));

  const span = Math.max(0.001, endS - startS);
  const starts: number[] = [];
  const ends: number[] = [];
  for (let index = 0; index < tokens.length; index++) {
    starts.push(round2(startS + (span * index) / tokens.length));
    ends.push(round2(startS + (span * (index + 1)) / tokens.length));
  }

  return { text: tokens, starts, ends };
}

/**
 * Compile the fixture into a time-ordered list of caption publishes for one
 * pass, plus the total loop length.
 *
 * Per utterance: an interim caption (`inProgress = progresstxt`) at the halfway
 * point - skipped when `progresstxt` is empty - then a final caption
 * (`final = spoken`, `inProgress = null`) at `end`. This mirrors the real
 * pipeline's "interim replaces, final commits" contract
 * (`transcription-content-store`), so the browser sees a guess that is then
 * corrected. The gaps between utterances are dead air: the inter-phrase pauses.
 */
export function buildDemoSchedule(utterances: readonly DemoUtterance[]): {
  events: ScheduledEvent[];
  loopMs: number;
} {
  const events: ScheduledEvent[] = [];
  let previousSpeaker: string | null = null;

  for (const utterance of utterances) {
    const turnStart = utterance.speaker !== previousSpeaker;
    previousSpeaker = utterance.speaker;

    const durationS = Math.max(0, utterance.end - utterance.start);
    const midpointS = utterance.start + durationS / 2;

    if (utterance.progresstxt.trim() !== '') {
      events.push({
        atMs: Math.round(midpointS * 1000),
        message: {
          final: null,
          inProgress: buildFragment(
            utterance.progresstxt,
            utterance.speaker,
            turnStart,
            utterance.start,
            midpointS,
          ),
        },
      });
    }

    events.push({
      atMs: Math.round(utterance.end * 1000),
      message: {
        final: buildFragment(
          utterance.spoken,
          utterance.speaker,
          turnStart,
          utterance.start,
          utterance.end,
        ),
        inProgress: null,
      },
    });
  }

  events.sort((a, b) => a.atMs - b.atMs);
  const lastAtMs = events.reduce((max, event) => Math.max(max, event.atMs), 0);
  return { events, loopMs: lastAtMs + DEMO_LOOP_TAIL_GAP_MS };
}

/**
 * Source of a self-contained, looping caption stream.
 *
 * When enabled, it publishes the compiled fixture to `TranscriptChannel` for
 * the demo session on a self-correcting virtual clock - exactly the channel the
 * orchestrator publishes real transcripts on - so every client subscribed to
 * the demo session receives captions with no audio, no source device, and no
 * upstream transcription service. It also registers a synthetic "healthy"
 * status for the session so a joining browser is not told to wait for a source.
 *
 * The loop repeats forever. It is never constructed when the feature is off
 * (see `create-server.ts`), so a production instance carries no demo behaviour.
 */
export class DemoCaptionSource {
  private readonly _logger: AppDependencies['logger'];
  private readonly _eventBus: AppDependencies['eventBusService'];
  private readonly _orchestrator: AppDependencies['transcriptionOrchestratorService'];
  private readonly _config: DemoRoomConfig;

  private _events: ScheduledEvent[] = [];
  private _loopMs = 0;
  /** Wall-clock ms mapped to virtual time 0 for the current loop pass. */
  private _baseMs = 0;
  private _timer: ReturnType<typeof setTimeout> | null = null;
  private _stopped = false;

  constructor(
    logger: AppDependencies['logger'],
    eventBusService: AppDependencies['eventBusService'],
    transcriptionOrchestratorService: AppDependencies['transcriptionOrchestratorService'],
    demoRoomConfig: DemoRoomConfig,
  ) {
    this._logger = logger;
    this._eventBus = eventBusService;
    this._orchestrator = transcriptionOrchestratorService;
    this._config = demoRoomConfig;
  }

  /**
   * Begin looping the fixture. No-op when the feature is disabled or the
   * fixture compiles to no events. Safe to call once at boot.
   */
  start(): void {
    if (!this._config.enabled) return;

    const { events, loopMs } = buildDemoSchedule(UTTERANCES);
    if (events.length === 0) {
      this._logger.warn(
        'demo caption room enabled but the fixture produced no events; not starting',
      );
      return;
    }
    this._events = events;
    this._loopMs = loopMs;

    // Make the session report healthy to clients that authenticate after the
    // loop starts (the controller reads getStatus once on connect) and to any
    // already-connected client (via the bus).
    const status = {
      transcriptionServiceConnected: true,
      sourceDeviceConnected: true,
    };
    this._orchestrator.registerSyntheticSession(
      this._config.sessionUid,
      status,
    );
    this._eventBus.publish(
      SessionStatusChannel,
      status,
      this._config.sessionUid,
    );

    this._baseMs = Date.now();
    this._logger.info(
      {
        sessionUid: this._config.sessionUid,
        utterances: UTTERANCES.length,
        events: events.length,
        loopSeconds: round2(loopMs / 1000),
      },
      'demo caption room started (Alice in Wonderland Ch. V, Project Gutenberg #11)',
    );
    this._run(0);
  }

  /** Stop the loop and release the pending timer. Idempotent. */
  stop(): void {
    this._stopped = true;
    if (this._timer !== null) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }

  /**
   * Schedule event `index` (or the loop wrap when `index` is past the end)
   * against `_baseMs`, so per-event delays never accumulate drift.
   */
  private _run(index: number): void {
    if (this._stopped) return;

    const event = this._events[index]; // undefined at the loop-wrap boundary
    const targetMs = event ? event.atMs : this._loopMs;
    const delayMs = Math.max(0, this._baseMs + targetMs - Date.now());

    this._timer = setTimeout(() => {
      if (this._stopped) return;
      if (event) {
        this._eventBus.publish(
          TranscriptChannel,
          event.message,
          this._config.sessionUid,
        );
        this._run(index + 1);
      } else {
        this._baseMs += this._loopMs;
        this._run(0);
      }
    }, delayMs);
  }
}
