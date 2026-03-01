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
    joinCode: string | null,
  ) {
    return await this._dbClient.db.transaction().execute(async (trx) => {
      const session = await trx
        .insertInto('sessions')
        .values({
          source_device_id: sourceDeviceId,
          transcription_provider_key: transcriptionProviderKey,
          transcription_provider_config: JSON.stringify(
            transcriptionProviderConfig,
          ),
          start_time: startTime,
          end_time: endTime,
          join_code: joinCode,
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      const startEvent = await trx
        .insertInto('session_events')
        .values({
          session_id: session.id,
          device_id: sourceDeviceId,
          event_type: 'START_SESSION',
          timestamp: startTime,
        })
        .returning(['id', 'session_id', 'event_type', 'timestamp'])
        .executeTakeFirstOrThrow();

      const endEvent = await trx
        .insertInto('session_events')
        .values({
          session_id: session.id,
          device_id: sourceDeviceId,
          event_type: 'END_SESSION',
          timestamp: endTime,
        })
        .returning(['id', 'session_id', 'event_type', 'timestamp'])
        .executeTakeFirstOrThrow();

      return { session, startEvent, endEvent };
    });
  }

  async findActiveSessionBySourceDevice(deviceId: string, sessionId: string) {
    const now = new Date();
    return await this._dbClient.db
      .selectFrom('sessions')
      .select([
        'id',
        'transcription_provider_key',
        'transcription_provider_config',
      ])
      .where('id', '=', sessionId)
      .where('source_device_id', '=', deviceId)
      .where('start_time', '<=', now)
      .where('end_time', '>', now)
      .executeTakeFirst();
  }

  async findActiveSessionByJoinCode(joinCode: string) {
    const now = new Date();
    return await this._dbClient.db
      .selectFrom('sessions')
      .select('id')
      .where('join_code', '=', joinCode)
      .where('start_time', '<=', now)
      .where('end_time', '>', now)
      .executeTakeFirst();
  }

  async deviceExists(deviceId: string): Promise<boolean> {
    const row = await this._dbClient.db
      .selectFrom('devices')
      .select('id')
      .where('id', '=', deviceId)
      .executeTakeFirst();
    return row !== undefined;
  }

  /**
   * Gets the next session event for a device within a time window.
   * @param deviceId Device to query events for
   * @param afterEventId Only return events with id > afterEventId (exclusive). Pass null to get from the beginning.
   * @param beforeTimestamp Only return events with timestamp <= beforeTimestamp
   */
  async getNextSessionEvent(
    deviceId: string,
    afterEventId: number | null,
    beforeTimestamp: Date,
  ) {
    return await this._dbClient.db
      .selectFrom('session_events')
      .select(['id', 'session_id', 'event_type', 'timestamp'])
      .where('device_id', '=', deviceId)
      .where('timestamp', '<=', beforeTimestamp)
      .$if(afterEventId !== null, (qb) => qb.where('id', '>', afterEventId))
      .orderBy('timestamp', 'asc')
      .limit(1)
      .executeTakeFirst();
  }
}
