import { EventEmitter } from 'eventemitter3';

import type { TranscriptionSequence } from '#src/core/transcription-content/store/transcription-content-slice';

export interface ProviderEvents<StatusType> {
  commitParagraphBreak: () => void;
  appendFinalizedTranscription: (sequence: TranscriptionSequence) => void;
  replaceInProgressTranscription: (sequence: TranscriptionSequence) => void;
  clearTranscription: () => void;
  statusChange: (newStatus: StatusType) => void;
}

export interface ProviderInterface<ConfigType, StatusType>
  extends EventEmitter<ProviderEvents<StatusType>> {
  get status(): StatusType;

  activateProvider(config: ConfigType): Promise<void> | void;

  deactivateProvider(): void;

  mute(): void;

  unmute(): void;
}
