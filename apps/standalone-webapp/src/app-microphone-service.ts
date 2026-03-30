import { MicrophoneService } from '@scribear/microphone-store';

// Singleton `MicrophoneService` instance shared across the standalone webapp.
export const appMicrophoneService = new MicrophoneService();
