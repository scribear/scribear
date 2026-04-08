import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GenericContainer,
  type StartedTestContainer,
  Wait,
} from 'testcontainers';
import type { ProvidedContext } from 'vitest';

const TRANSCRIPTION_SERVICE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../transcription_service',
);

const PROVIDER_CONFIG_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'provider-config.json',
);

const API_KEY = 'test-api-key';
const NODE_SERVER_KEY = 'test-node-server-key';
const PORT = 80;
const REDIS_PORT = 6379;

const DEBUG_PROVIDER_KEY = 'debug';
const DEBUG_PROVIDER_CONFIG = { sample_rate: 48000, num_channels: 1 };

let transcriptionContainer: StartedTestContainer;
let redisContainer: StartedTestContainer;
let mockSessionManagerServer: http.Server;

export async function setup({
  provide,
}: {
  provide: <T extends keyof ProvidedContext>(
    key: T,
    value: ProvidedContext[T],
  ) => void;
}) {
  const providerConfig = fs.readFileSync(PROVIDER_CONFIG_PATH, 'utf-8');

  const prebuiltImage = process.env['TRANSCRIPTION_SERVICE_IMAGE'];
  const transcriptionImage =
    prebuiltImage != null
      ? new GenericContainer(prebuiltImage)
      : await GenericContainer.fromDockerfile(
          TRANSCRIPTION_SERVICE_DIR,
          'Dockerfile_CPU',
        )
          .withCache(true)
          .build();

  [transcriptionContainer, redisContainer] = await Promise.all([
    transcriptionImage
      .withEnvironment({
        API_KEY,
        WS_INIT_TIMEOUT_SEC: '5',
        LOG_LEVEL: 'error',
      })
      .withCopyContentToContainer([
        {
          content: providerConfig,
          target: '/app/provider_config.json',
        },
      ])
      .withExposedPorts(PORT)
      .withWaitStrategy(Wait.forHealthCheck())
      .start(),
    new GenericContainer('redis:7-alpine')
      .withExposedPorts(REDIS_PORT)
      .withWaitStrategy(Wait.forListeningPorts())
      .start(),
  ]);

  // Mock session manager: serves GET /api/session-manager/session-management/v1/session-config/:sessionId
  // Session IDs starting with "not-found-" return 404.
  // Session IDs starting with "error-" return 500.
  // All others return 200 with debug provider config.
  const mockSessionManagerPort = await new Promise<number>(
    (resolve, reject) => {
      mockSessionManagerServer = http.createServer((req, res) => {
        const configRouteMatch = req.url?.match(
          /^\/api\/session-manager\/session-management\/v1\/session-config\/(.+)$/,
        );
        if (req.method === 'GET' && configRouteMatch?.[1]) {
          const sessionId = configRouteMatch[1];

          if (sessionId.startsWith('not-found-')) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ message: 'Session not found' }));
            return;
          }
          if (sessionId.startsWith('error-')) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ message: 'Internal server error' }));
            return;
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              transcriptionProviderKey: DEBUG_PROVIDER_KEY,
              transcriptionProviderConfig: DEBUG_PROVIDER_CONFIG,
              endTimeUnixMs: null,
            }),
          );
        } else {
          res.writeHead(404);
          res.end();
        }
      });
      mockSessionManagerServer.listen(0, () => {
        const addr = mockSessionManagerServer.address();
        if (addr && typeof addr === 'object') {
          resolve(addr.port);
        } else {
          reject(new Error('Failed to start mock session manager'));
        }
      });
    },
  );

  const host = transcriptionContainer.getHost();
  const mappedPort = transcriptionContainer.getMappedPort(PORT);
  const redisHost = redisContainer.getHost();
  const redisMappedPort = redisContainer.getMappedPort(REDIS_PORT);

  provide('transcriptionServiceManagerConfig', {
    transcriptionServiceAddress: `http://${host}:${mappedPort.toString()}`,
    transcriptionServiceApiKey: API_KEY,
    sessionManagerAddress: `http://localhost:${mockSessionManagerPort.toString()}`,
    nodeServerKey: NODE_SERVER_KEY,
    redisUrl: `redis://${redisHost}:${redisMappedPort.toString()}`,
  });
}

export async function teardown() {
  await Promise.all([
    transcriptionContainer.stop(),
    redisContainer.stop(),
    new Promise<void>((resolve) => {
      mockSessionManagerServer.close(() => {
        resolve();
      });
    }),
  ]);
}
