import Type from 'typebox';
import { Validator } from 'typebox/compile';

import { FinalTranscriptMessageSchema } from './final-transcription-message.js';
import { IPTranscriptMessageSchema } from './ip-transcription-message.js';

export * from './server-message-types.js';
export * from './ip-transcription-message.js';
export * from './final-transcription-message.js';

export const ServerMessageValidator = new Validator(
  {},
  Type.Union([IPTranscriptMessageSchema, FinalTranscriptMessageSchema]),
);
