/**
 * Runtime status values for the Azure Speech-to-Text transcription provider.
 * Reflects the full connection and transcription lifecycle.
 */
export enum AzureStatus {
  // Provider has not been activated.
  INACTIVE = 'INACTIVE',
  // Provider is establishing a connection to Azure.
  CONNECTING = 'CONECTING',
  // Connection was lost after a successful activation.
  DISCONNECTED = 'DISCONNECTED',
  // Provider is actively transcribing audio.
  ACTIVE = 'ACTIVE',
  // Provider is connected but microphone is muted; not transcribing.
  ACTIVE_MUTE = 'ACTIVE_MUTE',
  // Provider encountered an unrecoverable error.
  ERROR = 'ERROR',
}
