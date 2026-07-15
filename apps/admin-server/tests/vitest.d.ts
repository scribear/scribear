import type { AdminDbClientConfig } from '#src/db/admin-db-client.js';

declare module 'vitest' {
  export interface ProvidedContext {
    dbConfig: AdminDbClientConfig;
  }
}
