import type { TranscriptionProviderConfig } from '@scribear/transcription-service-schema';

import type { AppDependencies } from '#src/server/dependency-injection/register-dependencies.js';

export class SessionManagementRepository {
  private _dbClient: AppDependencies['dbClient'];

  constructor(dbClient: AppDependencies['dbClient']) {
    this._dbClient = dbClient;
  }

  async createSession(
    sourceDeviceId: string,
    transcriptionProviderKey: string,
    transcriptionProviderConfig: TranscriptionProviderConfig,
    startTime: Date,
    endTime: Date,
  ) {
    return await this._dbClient.db
      .insertInto('sessions')
      .values({
        source_device_id: sourceDeviceId,
        transcription_provider_key: transcriptionProviderKey,
        transcription_provider_config: JSON.stringify(
          transcriptionProviderConfig,
        ),
        start_time: startTime,
        end_time: endTime,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
  }
}
