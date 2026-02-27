import { StreamtextStatus } from '../types/streamtext-status';

export interface StreamtextConfig {
  event: string;
  language: string;
  startPosition: number;
}

// StreamText polling uses event id, language, and cursor position (lastPosition).
export const DEFAULT_STREAMTEXT_CONFIG = {
  event: '',
  language: 'en',
  startPosition: 0,
};

export const STREAMTEXT_DISPLAY_NAME = 'StreamText';

export const INITIAL_STREAMTEXT_STATUS = StreamtextStatus.INACTIVE;
