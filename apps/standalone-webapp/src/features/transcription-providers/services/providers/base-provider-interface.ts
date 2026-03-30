import EventEmitter from 'eventemitter3';

import type { TranscriptionSequenceInput } from '@scribear/transcription-content-store';

import type { ProviderEvents } from './provider-interface';

/**
 * Abstract base class for transcription provider implementations. Manages the
 * current status value and provides protected helper methods for emitting the
 * standard `ProviderEvents` (paragraph breaks, finalized/in-progress
 * transcription, status changes, and clear events).
 */
export class BaseProviderInterface<StatusType> extends EventEmitter<
  ProviderEvents<StatusType>
> {
  protected _status: StatusType;
  /**
   * The provider's current status value.
   */
  get status() {
    return this._status;
  }

  /**
   * Updates the internal status and emits a `statusChange` event.
   *
   * @param newStatus - The new status to set.
   */
  protected _setStatus(newStatus: StatusType) {
    this._status = newStatus;
    this.emit('statusChange', newStatus);
  }

  constructor(initialStatus: StatusType) {
    super();
    this._status = initialStatus;
  }

  /**
   * Emits a `commitParagraphBreak` event signalling a natural pause in speech.
   */
  protected _commitParagraphBreak() {
    this.emit('commitParagraphBreak');
  }

  /**
   * Emits an `appendFinalizedTranscription` event with a completed speech segment.
   *
   * @param sequence - The finalized transcription sequence to append.
   */
  protected _appendFinalizedTranscription(
    sequence: TranscriptionSequenceInput,
  ) {
    this.emit('appendFinalizedTranscription', sequence);
  }

  /**
   * Emits a `replaceInProgressTranscription` event with the current interim result.
   *
   * @param sequence - The in-progress transcription sequence to display.
   */
  protected _replaceInProgressTranscription(
    sequence: TranscriptionSequenceInput,
  ) {
    this.emit('replaceInProgressTranscription', sequence);
  }

  /**
   * Emits a `clearTranscription` event to wipe all transcription content from the display.
   */
  protected _clearTranscription() {
    this.emit('clearTranscription');
  }
}
