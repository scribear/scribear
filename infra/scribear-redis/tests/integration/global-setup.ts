import {
  GenericContainer,
  type StartedTestContainer,
  Wait,
} from 'testcontainers';
import type { ProvidedContext } from 'vitest';

const REDIS_PORT = 6379;
const REDIS_PASSWORD = 'test';

let container: StartedTestContainer;

export async function setup({
  provide,
}: {
  provide: <T extends keyof ProvidedContext>(
    key: T,
    value: ProvidedContext[T],
  ) => void;
}) {
  container = await new GenericContainer('redis:8-alpine')
    .withCommand(['redis-server', '--requirepass', REDIS_PASSWORD])
    .withExposedPorts(REDIS_PORT)
    .withWaitStrategy(Wait.forLogMessage('Ready to accept connections'))
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(REDIS_PORT);

  provide('redisUrl', `redis://:${REDIS_PASSWORD}@${host}:${String(port)}`);
}

export async function teardown() {
  await container.stop();
}

declare module 'vitest' {
  export interface ProvidedContext {
    redisUrl: string;
  }
}
