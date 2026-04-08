import type { DBClientConfig } from '#src/db/db-client.js';

declare module 'vitest' {
  export interface ProvidedContext {
    dbConfig: DBClientConfig;
    redisUrl: string;
  }
}
