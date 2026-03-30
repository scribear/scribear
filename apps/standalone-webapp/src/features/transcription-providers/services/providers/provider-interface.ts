import { EventEmitter } from 'eventemitter3';

import type { TranscriptionSequenceInput } from '@scribear/transcription-content-store';

/**
 * Events that every transcription provider implementation must be able to emit.
 * `StatusType` is the provider-specific status enum.
 */
export interface ProviderEvents<StatusType> {
  commitParagraphBreak: () => void;
  appendFinalizedTranscription: (sequence: TranscriptionSequenceInput) => void;
  replaceInProgressTranscription: (
    sequence: TranscriptionSequenceInput,
  ) => void;
  clearTranscription: () => void;
  statusChange: (newStatus: StatusType) => void;
}

/**
 * Contract that every transcription provider must satisfy. Extends `EventEmitter`
 * with the standard provider events and exposes lifecycle methods for activation,
 * deactivation, and microphone mute/unmute control.
 */
export interface ProviderInterface<ConfigType, StatusType> extends EventEmitter<
  ProviderEvents<StatusType>
> {
  get status(): StatusType;

  activateProvider(config: ConfigType): Promise<void> | void;

  deactivateProvider(): void;

  mute(): void;

  unmute(): void;
}
