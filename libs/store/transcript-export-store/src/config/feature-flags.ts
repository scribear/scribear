/**
 * Master switch for the on-device summary feature.
 *
 * **Currently off.** Not because the code is unfinished — it is complete and
 * covered by tests, including a real-browser run of the recursive reduction —
 * but because the model it depends on has never produced a single summary on
 * any machine this repo has been developed on, so nobody has read its output.
 *
 * Shipping a button whose result no one has seen is the problem. The summary
 * lands in a `.txt` that gets mailed on and read months later; if its quality,
 * length or format is wrong, that is discovered by the person relying on it.
 *
 * What is known (see `tools/transcript-export-e2e/README.md` for the evidence):
 * Chrome exposes `Summarizer` but never resolves a device performance class, so
 * `availability()` answers `"unavailable"` permanently and `create()` throws
 * "the service is not running". Seven launch configurations, a fully freed GPU
 * and an override switch all gave the same answer.
 *
 * ## Turning it on
 *
 * 1. Flip this to `true`.
 * 2. Run `npm run e2e:export` on a machine where `chrome://on-device-internals`
 *    reports a real **Device performance class** rather than `Loading...`. The
 *    four conditional checks in that tool switch from asserting the feature is
 *    withheld to running the real model.
 * 3. Read the summary it produces. Check that `type`/`length` in
 *    `SUMMARIZER_OPTIONS` (`summarization-service.ts`) give something worth
 *    saving for a real lecture transcript, and that `MAX_CHUNK_CHARS` still
 *    yields detail proportional to the material.
 *
 * Nothing else needs changing: with this `false` the service reports itself
 * unsupported, which the UI already handles by omitting every summary control
 * while leaving the transcript download alone. That path is the one users get
 * today and it is covered by its own tests.
 */
export const IS_SUMMARIZATION_ENABLED = false;
