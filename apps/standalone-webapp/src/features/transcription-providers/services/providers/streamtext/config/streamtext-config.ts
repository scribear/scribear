import { StreamtextStatus } from '../types/streamtext-status';

/**
 * Configuration for the StreamText live captioning transcription provider.
 */
export interface StreamtextConfig {
  // StreamText event identifier used to form the captions polling URL.
  event: string;
  // Language code for the captions feed (e.g. `"en"`).
  language: string;
  // Cursor position to begin reading captions from; 0 starts from the beginning.
  startPosition: number;
}

// Default StreamText configuration before the user enters an event name.
// StreamText polling uses event id, language, and cursor position (lastPosition).
export const DEFAULT_STREAMTEXT_CONFIG = {
  event: '',
  language: 'en',
  startPosition: 0,
};

// Human-readable name shown in the UI for the StreamText provider.
export const STREAMTEXT_DISPLAY_NAME = 'StreamText';

// The status that `StreamtextProvider` is initialized with before activation.
export const INITIAL_STREAMTEXT_STATUS = StreamtextStatus.INACTIVE;
