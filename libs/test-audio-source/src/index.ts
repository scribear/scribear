export {
  DeviceAuthClient,
  DeviceAuthError,
  NoActiveSessionError,
} from './device-auth.js';
export type { DeviceAuthConfig, SessionCredentials } from './device-auth.js';

export {
  WavFormatError,
  decodeWav,
  encodeWav,
  sliceIntoChunks,
} from './wav.js';
export type { AudioChunk, DecodedWav } from './wav.js';

export {
  BYTES_PER_SAMPLE,
  FULL_SCALE,
  INT16_MAX,
  INT16_MIN,
  dbToLinear,
  dcOffsetOf,
  fromFloat,
  peakOf,
  rmsDbfs,
  sampleCount,
  saturate,
  toFloat,
} from './pcm.js';

export {
  NoiseGenerator,
  applyDcOffset,
  applyGainDb,
  clippedFraction,
  digitalSilence,
  hardClipToRail,
} from './effects.js';

export { createSeededRng, gaussian } from './rng.js';
export type { Rng } from './rng.js';

export {
  CLIP_IDS,
  CLOCK_SKEW_MS_MAX,
  CLOCK_SKEW_MS_MIN,
  FAULT_PARAM_DEFAULTS,
  GAIN_DB_MAX,
  GAIN_DB_MIN,
  GOOD_PARAM_DEFAULTS,
  NOISE_DB_LEVELS,
  NOISE_TYPES,
  SPEEDUP_MAX,
  SPEEDUP_MIN,
  clampFaultParams,
  clampGoodParams,
  nearestNoiseDb,
} from './params.js';
export type {
  ClipId,
  FaultParams,
  GoodParams,
  NoiseDb,
  NoiseType,
} from './params.js';

export {
  BAD_HEADER_SAMPLE_RATE,
  FaultEngine,
  sendIntervalMs,
} from './faults.js';
export type { ChunkPlan, ChunkPlanner, PlannedFrame } from './faults.js';

export { GoodEngine } from './good-engine.js';

export { connectStreamSocket, waitForSocketOpen } from './stream-socket.js';
export type { StreamSocket } from './stream-socket.js';

export { TestAudioStream } from './test-audio-stream.js';
export type {
  StreamCounters,
  StreamResult,
  TestAudioStreamConfig,
} from './test-audio-stream.js';
