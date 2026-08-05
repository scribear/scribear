import { EventEmitter } from 'eventemitter3';

import {
  CANDIDATE_TARGET_LANGUAGES,
  DEFAULT_TARGET_LANGUAGE,
  TRANSCRIPT_SOURCE_LANGUAGE,
  languageDisplayName,
} from './config/translation-languages.js';
import {
  type TranslatorApi,
  type TranslatorAvailability,
  type TranslatorInstance,
  getTranslatorApi,
} from './translator-api.js';

/**
 * How far behind live speech the translation queue is allowed to fall before
 * it starts discarding input. Past this point the captions on screen are no
 * longer a usable aid to the conversation happening in the room, so stale text
 * is dropped (and marked with an ellipsis) in favour of catching up.
 */
export const MAX_LAG_MS = 20_000;

/**
 * A single `translate()` call that produces nothing within this window is
 * treated as a failure, not as slowness: the request is aborted and the
 * failure is surfaced to the user.
 */
export const TRANSLATE_TIMEOUT_MS = 20_000;

/**
 * Consecutive finalized captions are merged into one `translate()` call up to
 * this many characters.
 *
 * This is both a quality and a throughput control. ASR finalizes in fragments
 * of a few words; translating each fragment alone strips the context the model
 * needs and reads badly in languages that reorder clauses. Merging also drains
 * a backlog far faster than one call per fragment, because per-call overhead
 * dominates at these sizes.
 */
export const MAX_BATCH_CHARS = 400;

/**
 * Hard ceiling on queued captions, so a translator wedged for a long time
 * cannot grow the queue without bound. Age-based dropping normally keeps the
 * queue far shorter than this.
 */
export const MAX_QUEUE_SEGMENTS = 200;

/** Text shown in place of captions that were dropped to catch up. */
export const GAP_MARKER = '…';

/**
 * The user-visible message for a translation failure. Deliberately blunt: a
 * reader who cannot follow the room needs to know the captions are gone, not
 * be reassured by a spinner.
 */
export const NO_TRANSLATIONS_MESSAGE = 'No translations are available.';

/**
 * Runtime state of in-browser translation.
 *
 * - `UNSUPPORTED` - this browser has no Translator API. The feature is hidden.
 * - `OFF` - supported, but the user has not turned translation on.
 * - `PREPARING` - `create()` is in flight for an already-downloaded model.
 * - `DOWNLOADING` - `create()` is in flight and pulling down a language model.
 * - `READY` - translating.
 * - `ERROR` - translation failed; see `errorMessage`.
 */
export enum TranslationStatus {
  UNSUPPORTED = 'UNSUPPORTED',
  OFF = 'OFF',
  PREPARING = 'PREPARING',
  DOWNLOADING = 'DOWNLOADING',
  READY = 'READY',
  ERROR = 'ERROR',
}

/**
 * A chunk of translated caption text, or a gap marker standing in for content
 * that was dropped to keep up with the speaker.
 */
export interface TranslatedSegment {
  id: string;
  text: string;
  kind: 'text' | 'gap';
}

/**
 * A target language offered in the picker, with whether choosing it will
 * trigger a model download.
 */
export interface TranslationLanguageOption {
  code: string;
  label: string;
  availability: TranslatorAvailability;
  requiresDownload: boolean;
}

/**
 * Everything the UI needs to render translation state. Emitted as one object
 * so a consumer (or Redux slice) never sees a half-applied transition.
 */
export interface TranslationServiceState {
  status: TranslationStatus;
  targetLanguage: string;
  /** 0..1 while `DOWNLOADING`, else null. */
  downloadProgress: number | null;
  /** Non-null only in `ERROR`. */
  errorMessage: string | null;
  /** True once captions have been dropped; cleared on reset. */
  hasDroppedContent: boolean;
  /** How many captions have been dropped in total; cleared on reset. */
  droppedCaptions: number;
}

/**
 * Timing for one completed `translate()` call, for the metrics overlay.
 *
 * Split into the two legs because they fail differently and are fixed
 * differently: `waitMs` growing means the model cannot keep up with the room
 * (the batch sat in the queue), while `translateMs` growing means individual
 * calls got slower. Their sum is how stale the oldest caption in the batch was
 * by the time its translation reached the screen, which is what a reader
 * actually experiences.
 *
 * Only emitted for calls that produced text: a failed call is already surfaced
 * as an `ERROR` state and a gap marker, and timing a timeout would just report
 * {@link TRANSLATE_TIMEOUT_MS} back.
 */
export interface TranslationSample {
  /** Time the oldest caption in the batch spent queued before the call. */
  waitMs: number;
  /** Duration of the `translate()` call itself. */
  translateMs: number;
  /** How many finalized captions the call covered. */
  captionCount: number;
  /** Captions still queued when the call finished, i.e. the backlog. */
  queuedCaptions: number;
}

/**
 * Event map for {@link TranslationService}.
 */
interface TranslationServiceEvents {
  /** Fired on any change to {@link TranslationServiceState}. */
  stateChange: (state: TranslationServiceState) => void;
  /** Fired when a translated segment (or gap marker) is ready to display. */
  segment: (segment: TranslatedSegment) => void;
  /** Fired when the translated caption history should be cleared. */
  cleared: () => void;
  /** Fired after each `translate()` call that produced text. */
  sample: (sample: TranslationSample) => void;
}

/** A caption waiting to be translated. */
interface QueuedCaption {
  text: string;
  enqueuedAt: number;
}

/** One batch pulled off the queue, with what it took to assemble it. */
interface CaptionBatch {
  text: string;
  /** When the oldest caption in the batch was queued. */
  oldestEnqueuedAt: number;
  captionCount: number;
}

/**
 * Drives in-browser translation of finalized captions.
 *
 * Contract with the rest of the app: **this class never throws and never
 * rejects.** Every call into the browser API is wrapped, because the API is
 * young, ships behind flags, downloads models over the network, and has been
 * observed to crash its own service process mid-session. A caption display
 * that dies with it would take the accessible transcript down alongside the
 * optional feature, so failures become an `ERROR` state instead.
 *
 * Only finalized captions are translated. Interim ASR output is rewritten
 * several times a second, so translating it would spend the model's entire
 * throughput on text that is about to be replaced.
 */
export class TranslationService extends EventEmitter<TranslationServiceEvents> {
  #api: TranslatorApi | null;
  #translator: TranslatorInstance | null = null;
  #status: TranslationStatus;
  #targetLanguage: string = DEFAULT_TARGET_LANGUAGE;
  #downloadProgress: number | null = null;
  #errorMessage: string | null = null;
  #hasDroppedContent = false;
  #droppedCaptions = 0;

  #queue: QueuedCaption[] = [];
  #isDraining = false;
  #segmentCounter = 0;
  /** Whether the last emitted segment was a gap, so drops can coalesce. */
  #lastEmittedWasGap = false;
  /**
   * Bumped on every `enable`/`disable`/`reset`. A drain loop that finds the
   * generation changed under it aborts instead of emitting captions for a
   * language, or a session, the user has already moved on from.
   */
  #generation = 0;

  #languageProbe: Promise<TranslationLanguageOption[]> | null = null;

  constructor() {
    super();
    this.#api = getTranslatorApi();
    this.#status = this.#api
      ? TranslationStatus.OFF
      : TranslationStatus.UNSUPPORTED;
  }

  /** Whether this browser exposes the Translator API at all. */
  get isSupported(): boolean {
    return this.#api !== null;
  }

  /** Current state snapshot; the same object shape `stateChange` emits. */
  get state(): TranslationServiceState {
    return {
      status: this.#status,
      targetLanguage: this.#targetLanguage,
      downloadProgress: this.#downloadProgress,
      errorMessage: this.#errorMessage,
      hasDroppedContent: this.#hasDroppedContent,
      droppedCaptions: this.#droppedCaptions,
    };
  }

  /** True while translated captions are being produced. */
  get isActive(): boolean {
    return (
      this.#status === TranslationStatus.READY ||
      this.#status === TranslationStatus.ERROR
    );
  }

  /**
   * Asks the browser which of {@link CANDIDATE_TARGET_LANGUAGES} it can
   * translate into, so the picker only ever lists languages that work.
   *
   * The result is cached for the life of the service: probing is a fixed cost
   * per tag and the answer only changes when a model finishes downloading,
   * which {@link refreshLanguages} exists to pick up.
   *
   * @returns Supported languages, sorted by display name. Empty if the API is
   *   absent or every probe failed.
   */
  async probeLanguages(): Promise<TranslationLanguageOption[]> {
    this.#languageProbe ??= this.#probeLanguages();
    return this.#languageProbe;
  }

  /** Discards the cached language probe so the next call re-queries. */
  refreshLanguages(): void {
    this.#languageProbe = null;
  }

  async #probeLanguages(): Promise<TranslationLanguageOption[]> {
    const api = this.#api;
    if (!api) return [];

    const probes = CANDIDATE_TARGET_LANGUAGES.map(
      async (code): Promise<TranslationLanguageOption | null> => {
        const availability = await this.#availabilityOf(api, code);
        if (availability === null || availability === 'unavailable') {
          return null;
        }
        return {
          code,
          label: languageDisplayName(code),
          availability,
          requiresDownload: availability !== 'available',
        };
      },
    );

    const results = await Promise.all(probes);
    return results
      .filter((option): option is TranslationLanguageOption => option !== null)
      .sort((a, b) => a.label.localeCompare(b.label));
  }

  async #availabilityOf(
    api: TranslatorApi,
    targetLanguage: string,
  ): Promise<TranslatorAvailability | null> {
    try {
      return await api.availability({
        sourceLanguage: TRANSCRIPT_SOURCE_LANGUAGE,
        targetLanguage,
      });
    } catch {
      // RangeError on a tag this build rejects, or any transient failure.
      // Either way the language is simply not offered.
      return null;
    }
  }

  /**
   * Availability of one target language, for the confirmation dialog that has
   * to tell the user whether turning translation on will download a model.
   *
   * @param targetLanguage - BCP-47 tag to check.
   * @returns The availability, or `'unavailable'` if the API is absent or the
   *   probe failed - both mean "do not offer this".
   */
  async checkAvailability(
    targetLanguage: string,
  ): Promise<TranslatorAvailability> {
    const api = this.#api;
    if (!api) return 'unavailable';
    return (await this.#availabilityOf(api, targetLanguage)) ?? 'unavailable';
  }

  /**
   * Turns translation on for `targetLanguage`, creating the translator and
   * downloading its model if needed.
   *
   * **Call this from inside a user-gesture handler.** Chromium requires user
   * activation for a `create()` that downloads, and rejects with
   * `NotAllowedError` otherwise.
   *
   * Safe to call while already enabled - it swaps languages, discarding
   * queued captions for the previous one.
   *
   * @param targetLanguage - BCP-47 tag to translate into.
   * @returns `true` if translation is now running.
   */
  async enable(targetLanguage: string): Promise<boolean> {
    const api = this.#api;
    if (!api) {
      this.#setState({ status: TranslationStatus.UNSUPPORTED });
      return false;
    }

    // Tear down whatever came before, and invalidate any in-flight drain.
    this.#generation += 1;
    const generation = this.#generation;
    this.#destroyTranslator();
    this.#queue = [];
    this.#lastEmittedWasGap = false;

    this.#setState({
      status: TranslationStatus.PREPARING,
      targetLanguage,
      downloadProgress: null,
      errorMessage: null,
    });

    let translator: TranslatorInstance;
    try {
      translator = await api.create({
        sourceLanguage: TRANSCRIPT_SOURCE_LANGUAGE,
        targetLanguage,
        monitor: (monitor) => {
          try {
            monitor.addEventListener('downloadprogress', (event) => {
              if (this.#generation !== generation) return;
              this.#setState({
                status: TranslationStatus.DOWNLOADING,
                downloadProgress: event.loaded,
              });
            });
          } catch {
            // A monitor that cannot report progress is not a reason to give
            // up on the download it was monitoring.
          }
        },
      });
    } catch (error) {
      if (this.#generation === generation) {
        this.#fail(describeCreateFailure(error, targetLanguage));
      }
      return false;
    }

    // The user switched language or turned translation off while create() was
    // in flight; this translator is already obsolete.
    if (this.#generation !== generation) {
      destroyQuietly(translator);
      return false;
    }

    this.#translator = translator;
    this.#setState({
      status: TranslationStatus.READY,
      downloadProgress: null,
      errorMessage: null,
    });
    // A freshly downloaded model changes what the picker should show.
    this.refreshLanguages();
    void this.#drain();
    return true;
  }

  /**
   * Turns translation off and releases the model. Queued captions are
   * discarded; already-translated text stays on screen until {@link reset}.
   */
  disable(): void {
    this.#generation += 1;
    this.#destroyTranslator();
    this.#queue = [];
    this.#lastEmittedWasGap = false;
    this.#setState({
      status: this.#api ? TranslationStatus.OFF : TranslationStatus.UNSUPPORTED,
      downloadProgress: null,
      errorMessage: null,
    });
  }

  /**
   * Clears queued and displayed translations, e.g. when a new session starts.
   * Leaves translation enabled.
   */
  reset(): void {
    this.#generation += 1;
    this.#queue = [];
    this.#lastEmittedWasGap = false;
    this.#hasDroppedContent = false;
    this.#droppedCaptions = 0;
    this.#emitState();
    this.emit('cleared');
    if (this.#translator) void this.#drain();
  }

  /**
   * Queues a finalized caption for translation. No-op unless translation is
   * running, so callers can submit unconditionally.
   *
   * @param text - The finalized caption text, in the transcript's language.
   */
  submit(text: string): void {
    if (!this.#translator) return;
    if (text.trim() === '') return;

    this.#queue.push({ text, enqueuedAt: Date.now() });
    if (this.#queue.length > MAX_QUEUE_SEGMENTS) {
      const overflow = this.#queue.splice(
        0,
        this.#queue.length - MAX_QUEUE_SEGMENTS,
      );
      this.#markDropped(overflow.length);
    }
    void this.#drain();
  }

  /** Releases the translator. Idempotent. */
  destroy(): void {
    this.#generation += 1;
    this.#destroyTranslator();
    this.#queue = [];
    this.removeAllListeners();
  }

  /**
   * Serial translate loop. Serial rather than concurrent because captions must
   * stay in spoken order; a parallel pass would need reassembly and would gain
   * nothing once batching already amortises per-call overhead.
   */
  async #drain(): Promise<void> {
    if (this.#isDraining) return;
    this.#isDraining = true;
    const generation = this.#generation;

    try {
      while (this.#queue.length > 0) {
        if (this.#generation !== generation || !this.#translator) return;

        this.#dropStaleCaptions();
        if (this.#queue.length === 0) return;

        const batch = this.#takeBatch();
        if (batch.text === '') continue;

        const startedAt = Date.now();
        const translated = await this.#translateWithTimeout(batch.text);
        if (this.#generation !== generation) return;

        if (translated === null) {
          // Nothing usable came back. Mark the hole so the reader can see
          // that words are missing rather than silently reading on.
          this.#markDropped(batch.captionCount);
          continue;
        }

        this.#emitSegment({ text: translated, kind: 'text' });
        this.emit('sample', {
          waitMs: Math.max(0, startedAt - batch.oldestEnqueuedAt),
          translateMs: Math.max(0, Date.now() - startedAt),
          captionCount: batch.captionCount,
          queuedCaptions: this.#queue.length,
        });
        if (this.#status === TranslationStatus.ERROR) {
          // A success after a failure means translation recovered.
          this.#setState({
            status: TranslationStatus.READY,
            errorMessage: null,
          });
        }
      }
    } finally {
      this.#isDraining = false;
      // A language switch or reset during an awaited translate() bumps the
      // generation and makes this loop bail. Anything queued since belongs to
      // the new generation and would otherwise sit untouched until the next
      // submit(), so hand it to a fresh loop.
      if (this.#generation !== generation && this.#queue.length > 0) {
        void this.#drain();
      }
    }
  }

  /**
   * Discards captions that have waited longer than {@link MAX_LAG_MS}.
   *
   * The check is on the *oldest* queued caption, which is the one whose
   * translation the reader is still waiting for - queue length is the wrong
   * signal, because a few long captions lag as badly as many short ones.
   */
  #dropStaleCaptions(): void {
    const staleBefore = Date.now() - MAX_LAG_MS;
    let dropped = 0;
    for (;;) {
      const oldest = this.#queue[0];
      if (oldest === undefined || oldest.enqueuedAt >= staleBefore) break;
      this.#queue.shift();
      dropped += 1;
    }
    if (dropped > 0) this.#markDropped(dropped);
  }

  /**
   * Pulls the next batch off the queue, up to {@link MAX_BATCH_CHARS}. Always
   * takes at least one caption, so an oversized single caption still moves.
   *
   * The oldest caption's enqueue time is carried out with the text: it is the
   * one the reader has been waiting on, so it is what the latency sample is
   * measured from.
   */
  #takeBatch(): CaptionBatch {
    const parts: string[] = [];
    let length = 0;
    let oldestEnqueuedAt = Date.now();
    for (;;) {
      const next = this.#queue[0];
      if (next === undefined) break;
      if (parts.length > 0 && length + next.text.length > MAX_BATCH_CHARS) {
        break;
      }
      this.#queue.shift();
      if (parts.length === 0) oldestEnqueuedAt = next.enqueuedAt;
      parts.push(next.text);
      length += next.text.length;
    }
    return {
      text: parts.join(' ').replace(/\s+/g, ' ').trim(),
      oldestEnqueuedAt,
      captionCount: parts.length,
    };
  }

  /**
   * One `translate()` call, bounded by {@link TRANSLATE_TIMEOUT_MS}.
   *
   * @returns The translation, or `null` if it failed or timed out - in which
   *   case the service has already moved to `ERROR`.
   */
  async #translateWithTimeout(text: string): Promise<string | null> {
    const translator = this.#translator;
    if (!translator) return null;

    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, TRANSLATE_TIMEOUT_MS);

    try {
      const result = await translator.translate(text, {
        signal: controller.signal,
      });
      return typeof result === 'string' ? result : null;
    } catch {
      // Timeout, abort, service crash, or a destroyed translator. The reader
      // needs to know either way, and the exact cause changes nothing here.
      this.#fail(NO_TRANSLATIONS_MESSAGE);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Records that content was lost, emitting a gap marker. Consecutive losses
   * coalesce into the marker already on screen instead of stacking ellipses.
   *
   * @param count - How many captions were lost. Counted separately from the
   *   `hasDroppedContent` flag because coalesced markers hide the scale: one
   *   ellipsis can stand for a single fragment or for a minute of speech.
   */
  #markDropped(count: number): void {
    this.#hasDroppedContent = true;
    this.#droppedCaptions += count;
    if (this.#lastEmittedWasGap) {
      this.#emitState();
      return;
    }
    this.#emitSegment({ text: GAP_MARKER, kind: 'gap' });
  }

  #emitSegment(segment: Omit<TranslatedSegment, 'id'>): void {
    this.#segmentCounter += 1;
    this.#lastEmittedWasGap = segment.kind === 'gap';
    this.emit('segment', {
      id: `translated-${this.#segmentCounter.toString()}`,
      ...segment,
    });
    this.#emitState();
  }

  #fail(message: string): void {
    this.#setState({
      status: TranslationStatus.ERROR,
      downloadProgress: null,
      errorMessage: message,
    });
  }

  #destroyTranslator(): void {
    if (this.#translator) destroyQuietly(this.#translator);
    this.#translator = null;
  }

  #setState(next: Partial<TranslationServiceState>): void {
    if (next.status !== undefined) this.#status = next.status;
    if (next.targetLanguage !== undefined) {
      this.#targetLanguage = next.targetLanguage;
    }
    if (next.downloadProgress !== undefined) {
      this.#downloadProgress = next.downloadProgress;
    }
    if (next.errorMessage !== undefined) this.#errorMessage = next.errorMessage;
    if (next.hasDroppedContent !== undefined) {
      this.#hasDroppedContent = next.hasDroppedContent;
    }
    this.#emitState();
  }

  #emitState(): void {
    this.emit('stateChange', this.state);
  }
}

/** `destroy()` on an already-dead translator can throw; that is not news. */
function destroyQuietly(translator: TranslatorInstance): void {
  try {
    translator.destroy();
  } catch {
    // Already destroyed or the backing service is gone.
  }
}

/**
 * Turns a `create()` rejection into something a reader can act on.
 *
 * `NotSupportedError` is by far the most common failure and does not mean
 * "temporarily broken" - it is what Chrome throws when the pair genuinely
 * cannot be served, including when the TranslateKit component has not
 * finished installing.
 */
function describeCreateFailure(error: unknown, targetLanguage: string): string {
  const name = error instanceof Error ? error.name : undefined;
  const language = languageDisplayName(targetLanguage);

  if (name === 'NotAllowedError') {
    return `Your browser blocked the ${language} translation model download.`;
  }
  if (name === 'NotSupportedError') {
    return `Your browser cannot translate into ${language} right now.`;
  }
  return `${language} translation could not be started.`;
}
