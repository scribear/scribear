import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect } from 'vitest';

import { parseTranscriptionHostSnapshot } from '#src/index.js';

/**
 * Walks upward rather than assuming a working directory, matching how the
 * audio-meter cross-check finds its own manifest.
 */
const MANIFEST_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../tools/telemetry-snapshot-crosscheck/transcription-host-snapshot.json',
);

/**
 * The TypeScript half of the transcription-host cross-check.
 *
 * `telemetry-schemas.test.ts` next door also exercises
 * `TRANSCRIPTION_HOST_SNAPSHOT_SCHEMA`, and cannot substitute for this: its
 * fixtures are written here, from the schema, so they agree with it by
 * construction. That is exactly how `contextIds` stayed declared as an array
 * of strings from the day it was written while the publisher emitted
 * integers - the fixture said `['faster-whisper', 'silero']`, which the
 * publisher has never been able to produce.
 *
 * The manifest this reads is not written here. It is emitted by
 * `RedisTelemetryPublisher.publish_once` in
 * `transcription_service/tests/unit/webserver/features/telemetry/host_snapshot_crosscheck_test.py`,
 * which asserts the committed file still equals what the publisher serializes.
 * So Python is the oracle and this side is the only one that can fail because
 * the *schema* is wrong - which is the whole point, and the reason the file
 * must never be hand-edited to make this suite pass.
 *
 * It carries what a debug-only host cannot: loaded model contexts, a worker
 * that has died, active jobs both correlated and not, and one provider of
 * every `kind`. The live leg in `apps/node-server` covers the real transport
 * and this one covers the shapes that only a loaded host reaches; neither is
 * sufficient alone.
 */
describe('transcription host snapshot cross-check', (it) => {
  const raw = fs.readFileSync(MANIFEST_PATH, 'utf8');

  it('parses the payload the Python publisher actually serializes', () => {
    // Act
    const result = parseTranscriptionHostSnapshot(raw);

    // Assert - the reason, not just the boolean: `false !== true` says
    // nothing about which field drifted, and the field is the finding.
    expect(
      result.ok ? '' : `${result.reason}: ${result.errors.join('; ')}`,
    ).toBe('');
  });

  it('was checked against a manifest that populates the nested shapes', () => {
    // Arrange - every array in this schema has a described element type, and
    // `[]` satisfies all of them. A manifest whose workers carried no
    // contexts and no jobs would parse under a schema that got both element
    // types wrong, which is precisely the state this cross-check exists to
    // rule out. So the manifest's own richness is asserted, not assumed.
    const manifest = JSON.parse(raw) as {
      workers: {
        contextIds: number[];
        activeJobs: unknown[];
        alive: boolean;
      }[];
      providers: Record<string, { kind: string; owningWorkers: unknown[] }>;
    };

    // Act
    const kinds = new Set(
      Object.values(manifest.providers).map((provider) => provider.kind),
    );

    // Assert
    expect(manifest.workers[0]?.contextIds.length).toBeGreaterThan(0);
    expect(manifest.workers[0]?.activeJobs.length).toBeGreaterThan(0);
    expect(manifest.workers.some((worker) => !worker.alive)).toBe(true);
    expect(kinds).toEqual(new Set(['local', 'remote', 'debug', 'unknown']));
    expect(
      Object.values(manifest.providers).some(
        (provider) => provider.owningWorkers.length > 0,
      ),
    ).toBe(true);
  });
});
