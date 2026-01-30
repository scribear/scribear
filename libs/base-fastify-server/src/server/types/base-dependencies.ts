import type { BaseLogger } from '../create-logger.js';

/**
 * Define the dependencies in dependency container provided by base fastify server
 */
interface BaseDependencies {
  logger: BaseLogger;
}

/**
 * Ensure fastify awilix container is typed correctly
 * Applications using this base fastify instance should extend BaseDependencies with their own dependencies
 * @see https://github.com/fastify/fastify-awilix?tab=readme-ov-file#typescript-usage
 */
declare module '@fastify/awilix' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface Cradle extends BaseDependencies {}

  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface RequestCradle extends BaseDependencies {}
}

export type { BaseDependencies };
