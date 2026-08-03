export { LongPollClient } from './long-poll-client.js';
export { createLongPollClient } from './create-long-poll-client.js';
export { LongPollResponseError } from './errors.js';
export {
  NetworkError,
  UnexpectedResponseError,
} from '@scribear/base-api-client';
export type {
  LongPollState,
  BackoffOptions,
  ConnectParams,
  LongPollClientOptions,
  LongPollClientEvents,
} from './long-poll-client.js';
export type { LongPollClientFactory } from './create-long-poll-client.js';
