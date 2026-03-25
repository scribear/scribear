import fs from 'node:fs';
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
const PORT = 80;

let container: StartedTestContainer;

export async function setup({
  provide,
}: {
  provide: <T extends keyof ProvidedContext>(
    key: T,
    value: ProvidedContext[T],
  ) => void;
}) {
  const providerConfig = fs.readFileSync(PROVIDER_CONFIG_PATH, 'utf-8');

  container = await GenericContainer.fromDockerfile(
    TRANSCRIPTION_SERVICE_DIR,
    'Dockerfile_CPU',
  )
    .withCache(true)
    .build('scribear/transcription-service-cpu:main')
    .then((image) =>
      image
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
    );

  const host = container.getHost();
  const mappedPort = container.getMappedPort(PORT);

  provide('transcriptionServiceConfig', {
    address: `http://${host}:${mappedPort.toString()}`,
    apiKey: API_KEY,
  });
}

export async function teardown() {
  await container?.stop();
}
