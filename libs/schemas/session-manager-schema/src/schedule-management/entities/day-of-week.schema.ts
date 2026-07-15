import { type Static, Type } from 'typebox';

export const DAY_OF_WEEK_SCHEMA = Type.Union(
  [
    Type.Literal('MON'),
    Type.Literal('TUE'),
    Type.Literal('WED'),
    Type.Literal('THU'),
    Type.Literal('FRI'),
    Type.Literal('SAT'),
    Type.Literal('SUN'),
  ],
  { $id: 'DayOfWeek' },
);

export type DayOfWeek = Static<typeof DAY_OF_WEEK_SCHEMA>;
