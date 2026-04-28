import { type Static, Type } from 'typebox';

export const SCHEDULE_FREQUENCY_SCHEMA = Type.Union(
  [Type.Literal('ONCE'), Type.Literal('WEEKLY'), Type.Literal('BIWEEKLY')],
  { $id: 'ScheduleFrequency' },
);

export type ScheduleFrequency = Static<typeof SCHEDULE_FREQUENCY_SCHEMA>;
