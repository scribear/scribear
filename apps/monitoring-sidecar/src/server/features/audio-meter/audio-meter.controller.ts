import type {
  BaseFastifyReply,
  BaseFastifyRequest,
} from '@scribear/base-fastify-server';

import type { AUDIO_METER_SCHEMA } from './audio-meter.schema.js';

/**
 * Serves the standalone meter page from memory.
 *
 * The file is read once at startup rather than per request: it is a fixed
 * asset, and a monitoring surface should not add filesystem I/O to a request
 * path that an operator may be reloading during an incident.
 */
export class AudioMeterController {
  private _page: string;

  constructor(audioMeterPage: string) {
    this._page = audioMeterPage;
  }

  page(
    _req: BaseFastifyRequest<typeof AUDIO_METER_SCHEMA>,
    res: BaseFastifyReply<typeof AUDIO_METER_SCHEMA>,
  ) {
    res
      // The page contains dB minus signs and meter glyphs; without an explicit
      // charset a browser may decode it as Latin-1 and mangle them.
      .header('content-type', 'text/html; charset=utf-8')
      .code(200)
      .send(this._page);
  }
}
