import type { TranscriptionProviderConfig } from '@scribear/transcription-service-schema';

import type { AppDependencies } from '#src/server/dependency-injection/register-dependencies.js';

export class SessionManagementService {
  private _sessionManagementRepository: AppDependencies['sessionManagementRepository'];

  constructor(
    sessionManagementRepository: AppDependencies['sessionManagementRepository'],
  ) {
    this._sessionManagementRepository = sessionManagementRepository;
  }

  async createOnDemandSession(
    sourceDeviceId: string,
    transcriptionProviderKey: string,
    transcriptionProviderConfig: TranscriptionProviderConfig,
    endTimeUnixMs: number,
  ) {
    const startTime = new Date();
    const endTime = new Date(endTimeUnixMs);

    const result = await this._sessionManagementRepository.createSession(
      sourceDeviceId,
      transcriptionProviderKey,
      transcriptionProviderConfig,
      startTime,
      endTime,
    );

    return { sessionId: result.id };
  }
}
