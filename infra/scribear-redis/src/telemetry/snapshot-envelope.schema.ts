import { Type } from 'typebox';

/**
 * Fields every telemetry snapshot carries on top of the payload a service
 * already reports about itself.
 *
 * `updatedAt` duplicates information a payload may already carry as an ISO
 * timestamp, and does so on purpose: it is the value written as the index
 * score, in the same unit, so a reader deciding whether a snapshot is stale
 * compares two integers rather than parsing a date on every record of every
 * poll. It is the publisher's wall clock and inherits that host's skew - see
 * the note on clocks in `telemetry-keys.ts`.
 */
export const SNAPSHOT_ENVELOPE_PROPERTIES = {
  updatedAt: Type.Integer({
    description:
      'Publish time in epoch milliseconds, on the publishing host’s clock. Equal to this record’s index score. Use it for staleness only; never for latency arithmetic across hosts.',
  }),
};
