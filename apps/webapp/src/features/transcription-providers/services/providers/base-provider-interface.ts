import EventEmitter from 'eventemitter3';

import type { TranscriptionSequence } from '#src/core/transcription-content/store/transcription-content-slice';

import type { ProviderEvents } from './provider-interface';

export class BaseProviderInterface<StatusType> extends EventEmitter<
  ProviderEvents<StatusType>
> {
  protected _status: StatusType;
  get status() {
    return this._status;
  }

  protected _setStatus(newStatus: StatusType) {
    this._status = newStatus;
    this.emit('statusChange', newStatus);
  }

  constructor(initialStatus: StatusType) {
    super();
    this._status = initialStatus;
  }

  protected _commitParagraphBreak() {
    this.emit('commitParagraphBreak');
  }

  protected _appendFinalizedTranscription(sequence: TranscriptionSequence) {
    this.emit('appendFinalizedTranscription', sequence);
  }

  protected _replaceInProgressTranscription(sequence: TranscriptionSequence) {
    this.emit('replaceInProgressTranscription', sequence);
  }

  protected _clearTranscription() {
    this.emit('clearTranscription');
  }
}
