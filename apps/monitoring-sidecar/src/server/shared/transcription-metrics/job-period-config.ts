/**
 * Parses `TRANSCRIPTION_JOB_PERIOD_MS`, the denominator of the derived
 * period-utilization series.
 *
 * **Why this is a per-provider map and not a number.** `job_period_ms` is a
 * *per-provider* field of transcription-service's `provider_config.json`, and
 * the shipped templates genuinely disagree with each other: the CUDA template
 * runs `whisper` and `crisper_whisper` at 500 ms and `lumen_granite` at 3000 ms
 * simultaneously (`deployment/provider_config.cuda.template.json`), the CPU
 * template runs whisper at 5000 ms, and the `debug` provider has no such field
 * at all — its period is hardcoded to 1000 ms in `debug_provider.py`. A single
 * global number therefore cannot be right for a deployment serving more than
 * one provider, and until this change the sidecar had one: a `1000` default that
 * matched *none* of the three configured periods in the CUDA deployment and
 * silently rescaled `scribear_asr_period_utilization` by 2x for whisper and
 * 0.33x for lumen_granite. Nothing errored, because nothing could — the number
 * is plausible at any value.
 *
 * **Why a hand-copied number at all.** Because transcription-service does not
 * report its providers' periods on any surface the sidecar can poll: neither
 * `GET /metrics/status` (which reports `providerKeys` but no per-provider
 * config) nor `GET /providers/health` carries it, and it is not on the Redis
 * fleet plane either. The poller prefers a reported period the moment one
 * appears (see `providerJobPeriodMs` in the body schema); this env var is the
 * fallback until then, and it is deliberately explicit per provider so that the
 * duplication is at least *visible* in the deployment config rather than hidden
 * behind a default.
 *
 * A provider with no entry here gets **no** period-utilization series rather
 * than one scaled by a guess — the same "no reading is not the same claim as a
 * bad reading" rule the fleet dashboard applies to audio status
 * (`apps/admin-webapp/src/features/dashboard/fleet-status.ts`). `scribear_asr_rtf`
 * and the duty-ratio counters are unaffected either way: transcription-service
 * measures those itself and they carry no dependency on the job period.
 */

/** Result of parsing the spec. Both halves are always returned. */
export interface ParsedJobPeriods {
  /** Provider key (as labelled on the wire) to job period in ms. */
  periods: Map<string, number>;
  /**
   * One message per rejected entry, for the caller to log. Collected rather
   * than thrown: a malformed period must not stop the sidecar from starting,
   * because everything else it monitors is unrelated to this one derived
   * series. Losing the series and saying why loudly is the right trade; losing
   * the whole dashboard is not.
   */
  errors: string[];
}

/**
 * Entries are separated by commas, semicolons or newlines — not by whitespace.
 * Whitespace has to stay insignificant *inside* an entry so that a hand-edited
 * `whisper = 500` still parses; treating it as a separator as well would make
 * that same value three malformed entries.
 */
const ENTRY_SEPARATOR = /[,;\r\n]+/;

/** A value that is only digits, i.e. the pre-per-provider form of this var. */
const BARE_NUMBER = /^\d+$/;

const FORMAT_HINT =
  'expected a comma-separated list of provider=period pairs, e.g. "whisper=500,lumen_granite=3000", matching job_period_ms per provider in the deployed provider_config.json';

/**
 * Parses `provider=periodMs` pairs.
 *
 * An empty spec is not an error: it is a deployment that has not stated any
 * period, and the honest result is no period-utilization series at all.
 *
 * A bare number — the format this variable used to take — is rejected rather
 * than applied to every provider. Silently accepting it is precisely the bug
 * this parser exists to remove, and accepting it *with* a warning would still
 * publish a number that is wrong by a factor of 2 or 6 on the shipped CUDA
 * config. The error names the replacement so an operator upgrading has one
 * thing to do.
 */
export function parseJobPeriods(spec: string): ParsedJobPeriods {
  const periods = new Map<string, number>();
  const errors: string[] = [];

  const trimmed = spec.trim();
  if (trimmed.length === 0) return { periods, errors };

  if (BARE_NUMBER.test(trimmed)) {
    errors.push(
      `TRANSCRIPTION_JOB_PERIOD_MS="${trimmed}" is a single global period, which cannot be correct for a deployment serving providers at different periods (the CUDA template ships whisper at 500 ms and lumen_granite at 3000 ms): ${FORMAT_HINT}`,
    );
    return { periods, errors };
  }

  for (const entry of trimmed.split(ENTRY_SEPARATOR)) {
    if (entry.length === 0) continue;

    const separator = entry.indexOf('=');
    if (separator === -1) {
      errors.push(
        `TRANSCRIPTION_JOB_PERIOD_MS entry "${entry}": ${FORMAT_HINT}`,
      );
      continue;
    }

    const providerKey = entry.slice(0, separator).trim();
    const rawPeriod = entry.slice(separator + 1).trim();
    // `Number('')` is 0, not NaN, so the emptiness check has to come first.
    const periodMs = rawPeriod.length === 0 ? Number.NaN : Number(rawPeriod);

    if (providerKey.length === 0) {
      errors.push(
        `TRANSCRIPTION_JOB_PERIOD_MS entry "${entry}" has no provider key: ${FORMAT_HINT}`,
      );
      continue;
    }
    if (!Number.isFinite(periodMs) || periodMs <= 0) {
      errors.push(
        `TRANSCRIPTION_JOB_PERIOD_MS entry "${entry}" has no positive period in milliseconds: ${FORMAT_HINT}`,
      );
      continue;
    }
    if (periods.has(providerKey)) {
      errors.push(
        `TRANSCRIPTION_JOB_PERIOD_MS names provider "${providerKey}" twice; keeping the first (${String(periods.get(providerKey))} ms) and ignoring "${entry}"`,
      );
      continue;
    }

    periods.set(providerKey, periodMs);
  }

  return { periods, errors };
}
