/**
 * Runtime status values for the Web Speech API transcription provider.
 * Covers the full lifecycle from inactive through activation and error states.
 */
export enum WebspeechStatus {
  // Provider has not been activated.
  INACTIVE = 'INACTIVE',
  // Browser does not support the Web Speech API.
  UNSUPPORTED = 'UNSUPPORTED',
  // Provider is initializing the `SpeechRecognition` session.
  ACTIVATING = 'ACTIVATING',
  // Provider is actively transcribing audio.
  ACTIVE = 'ACTIVE',
  // Provider is initialized but microphone is muted; recognition is paused.
  ACTIVE_MUTE = 'ACTIVE_MUTE',
  // When there exist network error, we will reconnect the webspeech
  NETWORK_RETRYING = 'NETWORK_RETRYING',
  // Provider encountered an unrecoverable error.
  ERROR = 'ERROR',
}
