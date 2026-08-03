import { EventEmitter } from 'eventemitter3';

import { IS_SUMMARIZATION_ENABLED } from './config/feature-flags.js';
import {
  type SummarizerApi,
  type SummarizerAvailability,
  type SummarizerCoreOptions,
  type SummarizerInstance,
  getSummarizerApi,
} from './summarizer-api.js';
import { bisect, countWords, splitIntoChunks } from './utils/split-text.js';

/**
 * Target size of one summarization request, in characters.
 *
 * Chrome's quota is 9216 tokens, and measured usage runs at roughly
 * `560 + 0.21 x chars`, so the hard ceiling is near 41,000 characters. This
 * sits far below it on purpose. The limit that bites first is not the quota
 * but the summary: asked to reduce 40,000 characters at once, the model
 * returns the same three bullet points it would give for 4,000, and an hour of
 * a lecture collapses into a sentence. Smaller sections summarised separately
 * and then combined keep detail proportional to the material.
 */
export const MAX_CHUNK_CHARS = 12_000;

/**
 * Ceiling on reduction passes over the transcript.
 *
 * Each pass summarises the previous pass's output, so text shrinks
 * geometrically and nearly all the cost is in pass one. Six is set for a weak
 * summarizer - one that only cuts its input by ~40% per pass still converges
 * on a multi-hour transcript - rather than for the typical case, which needs
 * two or three. The cap exists for the case where it does not shrink at all;
 * see {@link SummarizationService}.
 */
export const MAX_PASSES = 6;

/**
 * A single `summarize()` call that produces nothing within this window is
 * treated as a failure. Generous, because the foundation model genuinely takes
 * 5-10 seconds for a short input and longer under load - this is the bound
 * that distinguishes "slow" from "wedged".
 */
export const SUMMARIZE_TIMEOUT_MS = 120_000;

/** Guard on re-splitting a chunk the model rejected. */
const MAX_BISECT_DEPTH = 4;

/** Model configuration. Plain text, because the output is written to a .txt. */
const SUMMARIZER_OPTIONS: SummarizerCoreOptions = {
  type: 'key-points',
  format: 'plain-text',
  length: 'medium',
  expectedInputLanguages: ['en'],
  // Always specified: without it Chrome warns that it cannot attest to output
  // safety, and the summary quality is documented to suffer.
  outputLanguage: 'en',
};

/** The user-visible message when summarization cannot produce anything. */
export const NO_SUMMARY_MESSAGE = 'The summary could not be generated.';

/**
 * Runtime state of on-device summarization.
 *
 * - `UNSUPPORTED` - no Summarizer API, or the model cannot run on this device.
 *   Either way the feature is hidden; the user has no path forward.
 * - `IDLE` - usable, nothing running.
 * - `DOWNLOADING` - fetching the ~1.8 GB foundation model.
 * - `SUMMARIZING` - running.
 * - `ERROR` - failed; see `errorMessage`.
 */
export enum SummarizationStatus {
  UNSUPPORTED = 'UNSUPPORTED',
  IDLE = 'IDLE',
  DOWNLOADING = 'DOWNLOADING',
  SUMMARIZING = 'SUMMARIZING',
  ERROR = 'ERROR',
}

/** Where a run has got to, for a progress display. */
export interface SummarizationProgress {
  /** 1-based. Pass 2 and beyond are summaries being summarised again. */
  pass: number;
  completedSections: number;
  totalSections: number;
}

/** Everything the UI needs, emitted as one object. */
export interface SummarizationServiceState {
  status: SummarizationStatus;
  /** Whether the model still has to be downloaded before a run can start. */
  availability: SummarizerAvailability | null;
  /** 0..1 while `DOWNLOADING`, else null. */
  downloadProgress: number | null;
  progress: SummarizationProgress | null;
  errorMessage: string | null;
  /** True once a summary has completed in this session. */
  hasCompletedRun: boolean;
}

/** A finished summary, with the provenance the output file records. */
export interface SummarizationResult {
  text: string;
  sourceWordCount: number;
  sectionCount: number;
  passes: number;
  /**
   * False when the reduction stopped early because it was not shrinking. The
   * summary is then a concatenation of section summaries rather than one
   * unified piece, and says so in the file.
   */
  converged: boolean;
}

interface SummarizationServiceEvents {
  stateChange: (state: SummarizationServiceState) => void;
}

/**
 * Summarises a transcript entirely on the user's device.
 *
 * **Recursive by necessity.** The model takes about 9K tokens at a time, which
 * a lecture transcript exceeds easily. So the transcript is cut into sections,
 * each section is summarised, the summaries are joined, and if the join is
 * still too big the whole thing runs again over that shorter text - map-reduce,
 * repeated until one call can cover what is left.
 *
 * The dangerous case in that loop is a pass that does not shrink its input:
 * key-point summaries of key-point summaries can hold steady or grow, and a
 * naive `while (tooLong)` would then never end while burning the user's
 * battery. Progress is therefore checked explicitly - a pass that fails to
 * reduce the text stops the loop and returns what it has, marked as not
 * converged.
 *
 * Like {@link TranslationService}, **this class never throws and never
 * rejects.** It is an optional convenience attached to an accessibility tool.
 */
export class SummarizationService extends EventEmitter<SummarizationServiceEvents> {
  #api: SummarizerApi | null;
  #status: SummarizationStatus;
  #availability: SummarizerAvailability | null = null;
  #downloadProgress: number | null = null;
  #progress: SummarizationProgress | null = null;
  #errorMessage: string | null = null;
  #hasCompletedRun = false;

  /** Aborts the run in flight. */
  #abortController: AbortController | null = null;

  /**
   * @param options.enabled - Overrides {@link IS_SUMMARIZATION_ENABLED}. Only
   *   tests and `tools/transcript-export-e2e` pass this: they exercise the
   *   machinery so it stays working while the feature is switched off, which is
   *   the whole point of switching it off rather than deleting it.
   */
  constructor(options: { enabled?: boolean } = {}) {
    super();
    // A disabled feature holds no API reference at all. Every downstream path
    // already treats a missing API as "unsupported", so the switch needs no
    // branches of its own - and, just as importantly, nothing probes the
    // browser or touches the model on a page load while it is off.
    const enabled = options.enabled ?? IS_SUMMARIZATION_ENABLED;
    this.#api = enabled ? getSummarizerApi() : null;
    this.#status = this.#api
      ? SummarizationStatus.IDLE
      : SummarizationStatus.UNSUPPORTED;
  }

  /**
   * Whether there is a Summarizer API to talk to: false when the browser lacks
   * it, and also false whenever the feature is switched off, so callers need
   * not know which. Still not a capability check - see
   * {@link checkAvailability}.
   */
  get isApiPresent(): boolean {
    return this.#api !== null;
  }

  /** Current state snapshot; the same shape `stateChange` emits. */
  get state(): SummarizationServiceState {
    return {
      status: this.#status,
      availability: this.#availability,
      downloadProgress: this.#downloadProgress,
      progress: this.#progress,
      errorMessage: this.#errorMessage,
      hasCompletedRun: this.#hasCompletedRun,
    };
  }

  /** Whether a run is in flight. */
  get isRunning(): boolean {
    return (
      this.#status === SummarizationStatus.SUMMARIZING ||
      this.#status === SummarizationStatus.DOWNLOADING
    );
  }

  /**
   * Asks the browser whether the model can run here, and whether it still has
   * to be downloaded.
   *
   * The answer is what decides whether the summary option appears at all: the
   * API object exists on machines whose hardware cannot host Gemini Nano, and
   * on those it answers `'unavailable'` while `create()` fails with "the
   * service is not running". Presence of the API is not a capability check.
   *
   * @returns The availability, or `'unavailable'` if the probe itself failed.
   */
  async checkAvailability(): Promise<SummarizerAvailability> {
    const api = this.#api;
    if (!api) {
      this.#setState({ status: SummarizationStatus.UNSUPPORTED });
      return 'unavailable';
    }

    let availability: SummarizerAvailability;
    try {
      availability = await api.availability(SUMMARIZER_OPTIONS);
    } catch {
      // TypeError on an option this build rejects, or any transient failure.
      availability = 'unavailable';
    }

    this.#setState({
      availability,
      // Do not clobber a run in flight, or an error the user has not seen yet.
      ...(this.isRunning || this.#status === SummarizationStatus.ERROR
        ? {}
        : {
            status:
              availability === 'unavailable'
                ? SummarizationStatus.UNSUPPORTED
                : SummarizationStatus.IDLE,
          }),
    });
    return availability;
  }

  /**
   * Summarises `transcript`, downloading the model first if needed.
   *
   * **Call this from inside a user-gesture handler.** Chromium requires user
   * activation for a `create()` that downloads, and the download here is
   * ~1.8 GB.
   *
   * @param transcript - The full transcript text.
   * @returns The summary, or `null` if it failed or was cancelled - in which
   *   case the state carries a message for the user.
   */
  async summarize(transcript: string): Promise<SummarizationResult | null> {
    const api = this.#api;
    if (!api) return null;
    if (this.isRunning) return null;

    const sourceWordCount = countWords(transcript);
    if (sourceWordCount === 0) {
      this.#fail('There is no transcript to summarize yet.');
      return null;
    }

    const controller = new AbortController();
    this.#abortController = controller;
    this.#setState({
      status: SummarizationStatus.SUMMARIZING,
      progress: null,
      errorMessage: null,
      downloadProgress: null,
    });

    let summarizer: SummarizerInstance;
    try {
      summarizer = await api.create({
        ...SUMMARIZER_OPTIONS,
        signal: controller.signal,
        monitor: (monitor) => {
          try {
            monitor.addEventListener('downloadprogress', (event) => {
              if (this.#abortController !== controller) return;
              this.#setState({
                status: SummarizationStatus.DOWNLOADING,
                downloadProgress: event.loaded,
              });
            });
          } catch {
            // A monitor that cannot report progress is not a reason to abandon
            // the download it was monitoring.
          }
        },
      });
    } catch (error) {
      if (this.#abortController === controller) {
        this.#fail(describeCreateFailure(error));
        this.#abortController = null;
      }
      return null;
    }

    if (this.#abortController !== controller) {
      destroyQuietly(summarizer);
      return null;
    }

    this.#setState({
      status: SummarizationStatus.SUMMARIZING,
      downloadProgress: null,
    });

    try {
      return await this.#reduce(
        summarizer,
        transcript,
        sourceWordCount,
        controller,
      );
    } finally {
      destroyQuietly(summarizer);
      if (this.#abortController === controller) this.#abortController = null;
    }
  }

  /** Cancels the run in flight. Safe to call when nothing is running. */
  cancel(): void {
    const controller = this.#abortController;
    if (!controller) return;
    this.#abortController = null;
    try {
      controller.abort();
    } catch {
      // Nothing useful to do; the run's own catch reports the outcome.
    }
    this.#setState({
      status: SummarizationStatus.IDLE,
      progress: null,
      downloadProgress: null,
      errorMessage: null,
    });
  }

  /** Releases resources. Idempotent. */
  destroy(): void {
    this.cancel();
    this.removeAllListeners();
  }

  /**
   * The map-reduce loop: summarise each section, join, repeat over the join
   * until one call can cover it.
   */
  async #reduce(
    summarizer: SummarizerInstance,
    transcript: string,
    sourceWordCount: number,
    controller: AbortController,
  ): Promise<SummarizationResult | null> {
    let text = transcript;
    let firstPassSections = 0;
    let pass = 0;

    for (;;) {
      pass += 1;
      const sections = splitIntoChunks(text, MAX_CHUNK_CHARS);
      if (pass === 1) firstPassSections = sections.length;

      if (sections.length === 0) {
        this.#fail('There is no transcript to summarize yet.');
        return null;
      }

      // One section left: this call produces the finished summary.
      if (sections.length === 1) {
        this.#reportProgress(pass, 0, 1);
        const summary = await this.#summarizeSection(
          summarizer,
          sections[0] ?? '',
          controller,
          0,
        );
        if (summary === null) return null;
        this.#reportProgress(pass, 1, 1);
        return this.#finish({
          text: summary,
          sourceWordCount,
          sectionCount: firstPassSections,
          passes: pass,
          converged: true,
        });
      }

      const summaries: string[] = [];
      this.#reportProgress(pass, 0, sections.length);
      for (const [index, section] of sections.entries()) {
        const summary = await this.#summarizeSection(
          summarizer,
          section,
          controller,
          0,
        );
        if (summary === null) return null;
        if (summary.trim() !== '') summaries.push(summary.trim());
        this.#reportProgress(pass, index + 1, sections.length);
      }

      const joined = summaries.join('\n\n');
      if (joined.trim() === '') {
        this.#fail(NO_SUMMARY_MESSAGE);
        return null;
      }

      // The loop's only real hazard: summarising summaries does not always
      // make them shorter. If a pass did not reduce the text, another pass
      // will not either - stop and hand back the section summaries rather than
      // spin. Same for the hard pass cap.
      const madeProgress = joined.length < text.length;
      if (!madeProgress || pass >= MAX_PASSES) {
        return this.#finish({
          text: joined,
          sourceWordCount,
          sectionCount: firstPassSections,
          passes: pass,
          converged: false,
        });
      }

      text = joined;
    }
  }

  /**
   * One `summarize()` call, bounded by {@link SUMMARIZE_TIMEOUT_MS}.
   *
   * A `QuotaExceededError` means the character budget guessed wrong about how
   * this particular text tokenises. Rather than fail the whole run, the
   * section is halved and each half summarised - the results are concatenated,
   * which the next pass will fold together anyway.
   *
   * @returns The summary text, or `null` if the run should stop.
   */
  async #summarizeSection(
    summarizer: SummarizerInstance,
    section: string,
    controller: AbortController,
    depth: number,
  ): Promise<string | null> {
    if (controller.signal.aborted) return null;

    const timeout = setTimeout(() => {
      controller.abort();
    }, SUMMARIZE_TIMEOUT_MS);

    try {
      const result = await summarizer.summarize(section, {
        signal: controller.signal,
      });
      return typeof result === 'string' ? result : '';
    } catch (error) {
      const name = error instanceof Error ? error.name : '';

      if (name === 'QuotaExceededError' && depth < MAX_BISECT_DEPTH) {
        const halves = bisect(section);
        if (halves) {
          clearTimeout(timeout);
          const first = await this.#summarizeSection(
            summarizer,
            halves[0],
            controller,
            depth + 1,
          );
          if (first === null) return null;
          const second = await this.#summarizeSection(
            summarizer,
            halves[1],
            controller,
            depth + 1,
          );
          if (second === null) return null;
          return [first, second]
            .filter((part) => part.trim() !== '')
            .join('\n\n');
        }
      }

      // Cancelled by the user is not an error to report at them.
      if (this.#abortController !== controller) return null;
      this.#fail(describeSummarizeFailure(error));
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  #finish(result: SummarizationResult): SummarizationResult {
    this.#hasCompletedRun = true;
    this.#setState({
      status: SummarizationStatus.IDLE,
      progress: null,
      errorMessage: null,
    });
    return result;
  }

  #reportProgress(
    pass: number,
    completedSections: number,
    totalSections: number,
  ): void {
    this.#setState({
      status: SummarizationStatus.SUMMARIZING,
      progress: { pass, completedSections, totalSections },
    });
  }

  #fail(message: string): void {
    this.#setState({
      status: SummarizationStatus.ERROR,
      progress: null,
      downloadProgress: null,
      errorMessage: message,
    });
  }

  #setState(next: Partial<SummarizationServiceState>): void {
    if (next.status !== undefined) this.#status = next.status;
    if (next.availability !== undefined) this.#availability = next.availability;
    if (next.downloadProgress !== undefined) {
      this.#downloadProgress = next.downloadProgress;
    }
    if (next.progress !== undefined) this.#progress = next.progress;
    if (next.errorMessage !== undefined) this.#errorMessage = next.errorMessage;
    if (next.hasCompletedRun !== undefined) {
      this.#hasCompletedRun = next.hasCompletedRun;
    }
    this.emit('stateChange', this.state);
  }
}

/** `destroy()` on an already-dead summarizer can throw; that is not news. */
function destroyQuietly(summarizer: SummarizerInstance): void {
  try {
    summarizer.destroy();
  } catch {
    // Already destroyed, or the backing service is gone.
  }
}

/**
 * Turns a `create()` rejection into something a reader can act on.
 *
 * `NotSupportedError` here usually is not about language support: it is what
 * Chrome throws when the on-device model service will not start, which is the
 * normal outcome on hardware below the Gemini Nano bar.
 */
function describeCreateFailure(error: unknown): string {
  const name = error instanceof Error ? error.name : undefined;
  if (name === 'AbortError') return NO_SUMMARY_MESSAGE;
  if (name === 'NotAllowedError') {
    return 'Your browser blocked the download of its built-in AI model.';
  }
  if (name === 'NotSupportedError') {
    return "This device cannot run your browser's built-in summarizer.";
  }
  return 'The built-in summarizer could not be started.';
}

/** Turns a `summarize()` rejection into something a reader can act on. */
function describeSummarizeFailure(error: unknown): string {
  const name = error instanceof Error ? error.name : undefined;
  if (name === 'QuotaExceededError') {
    return 'The transcript could not be broken into small enough pieces to summarize.';
  }
  if (name === 'NotReadableError') {
    return 'Your browser withheld the summary it generated.';
  }
  return NO_SUMMARY_MESSAGE;
}
