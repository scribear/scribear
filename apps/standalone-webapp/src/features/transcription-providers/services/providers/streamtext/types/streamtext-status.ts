/**
 * Runtime status values for the StreamText transcription provider.
 * Reflects the polling lifecycle from initial connection through active
 * captioning and error/disconnection states.
 */
export enum StreamtextStatus {
  // Provider has not been activated.
  INACTIVE = 'INACTIVE',
  // Provider is making its first polling request to StreamText.
  CONNECTING = 'CONNECTING',
  // Provider has failed several consecutive polls and is retrying.
  DISCONNECTED = 'DISCONNECTED',
  // Provider is successfully polling and receiving captions.
  ACTIVE = 'ACTIVE',
  // Provider is active but outputs are suppressed (mute state, unused by this provider).
  ACTIVE_MUTE = 'ACTIVE_MUTE',
  // Provider encountered an unrecoverable error (e.g. empty event name).
  ERROR = 'ERROR',
}
