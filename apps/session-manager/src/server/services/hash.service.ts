import bcrypt from 'bcrypt';

import type { AppDependencies } from '../dependency-injection/register-dependencies.js';

export interface HashServiceConfig {
  saltRounds: number;
}

export class HashService {
  private _config: HashServiceConfig;

  constructor(hashServiceConfig: AppDependencies['hashServiceConfig']) {
    this._config = hashServiceConfig;
  }

  async hashValue(value: string) {
    return await bcrypt.hash(value, this._config.saltRounds);
  }

  async compareHash(value: string, hash: string) {
    return await bcrypt.compare(value, hash);
  }
}
