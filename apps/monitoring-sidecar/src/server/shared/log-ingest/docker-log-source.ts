import http from 'node:http';
import type { Readable } from 'node:stream';

import type { BaseLogger } from '@scribear/base-fastify-server';

import type {
  LogIngestService,
  RawLogLine,
} from '#src/server/shared/log-ingest/log-ingest.service.js';
import { LogDialect } from '#src/server/shared/log-ingest/log-line.js';

export interface DockerLogSourceConfig {
  /** Path to the Docker Engine socket, mounted read-only. */
  socketPath: string;
  /**
   * Compose service names to follow, mapped to the log dialect they emit.
   * Attribution comes from here rather than from the log body, because neither
   * pino nor the Python JsonFormatter writes a service identifier.
   */
  services: Readonly<Record<string, LogDialect>>;
  /** Compose project label used to scope container discovery. */
  composeProject: string;
}

/** Docker's stream multiplexing header is 8 bytes: [type, 0,0,0, len32be]. */
const FRAME_HEADER_BYTES = 8;

/**
 * Streams container logs from the Docker Engine API and feeds them to the
 * ingest.
 *
 * Reads via the Docker socket rather than tailing
 * `/var/lib/docker/containers/*-json.log` because the socket also yields the
 * container -> compose-service mapping, which the sidecar needs (log bodies
 * carry no service name) and which the file layout only exposes via a separate
 * `config.v2.json` read.
 *
 * SECURITY: the Docker socket is root-equivalent on the host. It is mounted
 * read-only and this class only ever issues GETs, but the mount itself is the
 * risk. A deployment unwilling to accept that should switch to a log-shipping
 * driver instead; see PLAN-MONITORING-DASHBOARD.md §5 A1.
 */
export class DockerLogSource {
  private _config: DockerLogSourceConfig;
  private _ingest: LogIngestService;
  private _logger: BaseLogger;
  private _streams = new Set<Readable>();
  private _stopped = false;

  constructor(
    dockerLogSourceConfig: DockerLogSourceConfig,
    logIngestService: LogIngestService,
    logger: BaseLogger,
  ) {
    this._config = dockerLogSourceConfig;
    this._ingest = logIngestService;
    this._logger = logger;
  }

  /**
   * Discovers the configured containers and begins following each one's logs.
   *
   * Failure to attach to any single container is logged and skipped rather than
   * fatal — a monitoring sidecar that refuses to start because one service is
   * down is worse than useless.
   */
  async start(): Promise<void> {
    for (const [service, dialect] of Object.entries(this._config.services)) {
      try {
        const containerId = await this._findContainer(service);
        if (containerId === null) {
          this._logger.warn({ service }, 'no running container for service');
          continue;
        }
        this._followContainer(containerId, service, dialect);
        this._logger.info({ service, containerId }, 'following container logs');
      } catch (err) {
        this._logger.error({ err, service }, 'failed to attach to container');
      }
    }
  }

  /** Detaches from every stream. */
  stop(): void {
    this._stopped = true;
    for (const stream of this._streams) stream.destroy();
    this._streams.clear();
  }

  private async _findContainer(service: string): Promise<string | null> {
    const filters = encodeURIComponent(
      JSON.stringify({
        label: [
          `com.docker.compose.project=${this._config.composeProject}`,
          `com.docker.compose.service=${service}`,
        ],
        status: ['running'],
      }),
    );
    const body = await this._get(`/containers/json?filters=${filters}`);
    const containers = JSON.parse(body) as { Id: string }[];
    return containers[0]?.Id ?? null;
  }

  private _followContainer(
    containerId: string,
    service: string,
    dialect: LogDialect,
  ): void {
    // `since=0` plus `tail=0` means "only what happens from now on" — the
    // sidecar deliberately does not backfill history, because counters it
    // produced from a replay of old logs would misrepresent current rates.
    const path =
      `/containers/${containerId}/logs` +
      `?follow=1&stdout=1&stderr=1&tail=0&timestamps=0`;

    const req = http.request(
      { socketPath: this._config.socketPath, path, method: 'GET' },
      (res) => {
        this._streams.add(res);
        this._consumeFramedStream(res, service, dialect);
        res.on('error', (err) => {
          this._logger.warn({ err, service }, 'container log stream error');
        });
        res.on('end', () => {
          this._streams.delete(res);
          if (!this._stopped) {
            this._logger.warn({ service }, 'container log stream ended');
          }
        });
      },
    );
    req.on('error', (err) => {
      this._logger.error({ err, service }, 'container log request failed');
    });
    req.end();
  }

  /**
   * De-multiplexes Docker's framed log stream into whole lines.
   *
   * Without a TTY, Docker prefixes every chunk with an 8-byte header whose
   * first byte distinguishes stdout (1) from stderr (2). Both matter here:
   * node services log to stdout, transcription-service logs to stderr, so a
   * naive reader that assumed one or the other would silently see nothing from
   * half the stack.
   */
  private _consumeFramedStream(
    stream: Readable,
    service: string,
    dialect: LogDialect,
  ): void {
    let buffer = Buffer.alloc(0);
    // Partial trailing lines are held per stream type: a single log line can be
    // split across frames, and stdout/stderr must not be spliced together.
    const partial = new Map<number, string>();

    stream.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);

      while (buffer.length >= FRAME_HEADER_BYTES) {
        const streamType = buffer[0] ?? 0;
        const payloadLength = buffer.readUInt32BE(4);
        if (buffer.length < FRAME_HEADER_BYTES + payloadLength) break;

        const payload = buffer
          .subarray(FRAME_HEADER_BYTES, FRAME_HEADER_BYTES + payloadLength)
          .toString('utf8');
        buffer = buffer.subarray(FRAME_HEADER_BYTES + payloadLength);

        const carried = (partial.get(streamType) ?? '') + payload;
        const lines = carried.split('\n');
        // The final element is either '' (payload ended on a newline) or an
        // incomplete line to carry into the next frame.
        partial.set(streamType, lines.pop() ?? '');

        for (const text of lines) {
          if (text.trim() === '') continue;
          const raw: RawLogLine = { service, dialect, text };
          this._ingest.ingest(raw);
        }
      }
    });
  }

  private _get(path: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        { socketPath: this._config.socketPath, path, method: 'GET' },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (c: string) => (body += c));
          res.on('end', () => {
            if (res.statusCode !== undefined && res.statusCode >= 400) {
              reject(
                new Error(`Docker API ${String(res.statusCode)}: ${body}`),
              );
              return;
            }
            resolve(body);
          });
        },
      );
      req.on('error', reject);
      req.end();
    });
  }
}

/** Default service -> dialect map for the standard compose stack. */
export const DEFAULT_SERVICE_DIALECTS: Readonly<Record<string, LogDialect>> = {
  'node-server': LogDialect.PINO,
  'session-manager': LogDialect.PINO,
  'admin-server': LogDialect.PINO,
  'transcription-service': LogDialect.PYTHON,
};
