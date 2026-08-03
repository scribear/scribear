import type { TranscriptFragment } from '@scribear/node-server-schema';

import type { DemoRoomConfig } from '#src/app-config/app-config.js';
import type { AppDependencies } from '#src/server/dependency-injection/app-dependencies.js';
import { SessionStatusChannel } from '#src/server/features/transcription-stream/events/session-status.events.js';
import {
  TranscriptChannel,
  type TranscriptMessage,
} from '#src/server/features/transcription-stream/events/transcript.events.js';

import {
  DEMO_GAP_BETWEEN_TURNS_SECONDS,
  DEMO_GAP_WITHIN_TURN_SECONDS,
  DEMO_INTERIM_INTERVAL_SECONDS,
  DEMO_LOOP_TAIL_GAP_MS,
  DEMO_WORDS_PER_SECOND,
} from './demo-room.constants.js';
// The fixture is inlined into the bundle by esbuild at build time (only
// `dist/bundle.mjs` ships), so no file is read at runtime. Source & licence:
// Alice's Adventures in Wonderland, Project Gutenberg eBook #11 (public
// domain). See the fixture's `source` block and PLAN-Demo-CAPTION_ROOM.md.
import demoFixture from './fixtures/alice-book.utterances.json' with { type: 'json' };

/** One speaker turn from the fixture: one or more lines spoken back to back. */
interface DemoTurn {
  speaker: string;
  lines: readonly string[];
}

/** A single caption publish scheduled at `atMs` on the loop's virtual clock. */
interface ScheduledEvent {
  atMs: number;
  message: TranscriptMessage;
}

const TURNS = demoFixture.turns as unknown as readonly DemoTurn[];

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Splits on whitespace, dropping empty tokens (e.g. from repeated spaces). */
function splitWords(text: string): string[] {
  return text.split(/\s+/).filter((word) => word.length > 0);
}

/**
 * Turn one line's text into a wire {@link TranscriptFragment}: word tokens
 * (each carrying its leading space, so `text.join('')` reconstructs the
 * string) with per-token times spread evenly across `[startS, endS]`.
 *
 * Every token gets a leading space by default (`leadingSpace`), including the
 * first: `finalizedTranscription` sequences are concatenated back-to-back
 * with no separator on the client
 * (`transcription-content-slice.ts` `selectFinalizedText`), so without it,
 * consecutive finals run together (`"...since then!Alice: ..."`). The one
 * exception is the very first fragment ever published, which has nothing
 * before it to separate from.
 */
export function buildFragment(
  text: string,
  startS: number,
  endS: number,
  leadingSpace = true,
): TranscriptFragment {
  const words = splitWords(text);
  const tokens = words.map((word, index) =>
    index === 0 && !leadingSpace ? word : ` ${word}`,
  );

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
 * Per line: zero or more interim captions (`inProgress`) at roughly
 * {@link DEMO_INTERIM_INTERVAL_SECONDS} intervals, each a growing word-prefix
 * of the line (simulating a live transcript filling in), then one final
 * caption (`final`, `inProgress = null`) with the full line at its end. This
 * mirrors the real pipeline's "interim replaces, final commits" contract
 * (`transcription-content-store`). Lines shorter than one interim interval
 * (the common case for short exclamations) get no interim - just a final -
 * matching how a real transcript would have nothing to correct. The gaps
 * between lines/turns are dead air: the inter-phrase pauses.
 */
export function buildDemoSchedule(turns: readonly DemoTurn[]): {
  events: ScheduledEvent[];
  loopMs: number;
} {
  const events: ScheduledEvent[] = [];
  let t = 0;
  let isFirstFragment = true;

  let isFirstTurn = true;
  for (const turn of turns) {
    if (!isFirstTurn) t += DEMO_GAP_BETWEEN_TURNS_SECONDS;
    isFirstTurn = false;
    const { lines } = turn;

    let isFirstLine = true;
    for (const line of lines) {
      if (!isFirstLine) t += DEMO_GAP_WITHIN_TURN_SECONDS;
      isFirstLine = false;
      const words = splitWords(line);
      const startS = t;
      const durationS = Math.max(1, words.length / DEMO_WORDS_PER_SECOND);
      const endS = startS + durationS;

      for (
        let tick = DEMO_INTERIM_INTERVAL_SECONDS;
        tick < durationS;
        tick += DEMO_INTERIM_INTERVAL_SECONDS
      ) {
        const atS = startS + tick;
        const wordCount = Math.min(
          words.length - 1,
          Math.max(1, Math.round(words.length * (tick / durationS))),
        );
        events.push({
          atMs: Math.round(atS * 1000),
          message: {
            final: null,
            inProgress: buildFragment(
              words.slice(0, wordCount).join(' '),
              startS,
              atS,
              !isFirstFragment,
            ),
          },
        });
        isFirstFragment = false;
      }

      events.push({
        atMs: Math.round(endS * 1000),
        message: {
          final: buildFragment(line, startS, endS, !isFirstFragment),
          inProgress: null,
        },
      });
      isFirstFragment = false;

      t = endS;
    }
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

    const { events, loopMs } = buildDemoSchedule(TURNS);
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
        turns: TURNS.length,
        events: events.length,
        loopSeconds: round2(loopMs / 1000),
      },
      'demo caption room started (Alice in Wonderland, Project Gutenberg #11)',
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
