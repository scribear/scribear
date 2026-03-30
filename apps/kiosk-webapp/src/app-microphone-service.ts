import { MicrophoneService } from '@scribear/microphone-store';

// Singleton `MicrophoneService` instance shared across the kiosk webapp.
export const appMicrophoneService = new MicrophoneService();
