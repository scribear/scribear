---
'@scribear/transcript-export-store': minor
'@scribear/transcript-export-ui': minor
'@scribear/transcription-content-store': minor
'@scribear/client-webapp': minor
---

Let the client save the transcript as `transcript-YYYYMMDD-HHMMSS.txt`, and add
an on-device summary as `summary-YYYYMMDD-HHMMSS.txt` — **shipped switched off**
behind `IS_SUMMARIZATION_ENABLED` in
`@scribear/transcript-export-store/src/config/feature-flags.ts`.

The summary code is complete and tested, including a real-browser run of the
recursive reduction. It is off because the model it needs has never produced a
single summary on any machine this repo has been developed on, so nobody has
read its output — and that output lands in a `.txt` that gets mailed on and read
months later. Switching it off is one line, and the flag's comment carries the
evidence and the checklist for turning it on. With it off the service reports
itself unsupported, which the UI already handles by omitting every summary
control while leaving the transcript download alone.

**The transcript file is the transcript.** No header, no banner. It is the
record, and anything prepended would have to be stripped by every downstream
use; the filename already carries the timestamp. Interim ASR text is excluded,
so a file saved mid-word never contains a guess the recogniser was about to
revise.

**Summarization is recursive, because the model has a context limit.** Chrome's
summarizer takes about 9216 tokens per call, which a lecture transcript exceeds
easily. The transcript is split into sections at paragraph and sentence
boundaries, each section is summarized, the summaries are joined, and the whole
thing runs again over that shorter text until one call can cover what is left.

The hazard in that loop is a pass that does not shrink its input — key-point
summaries of key-point summaries can hold steady or grow, and a naive
`while (tooLong)` would never terminate while burning the user's battery.
Progress is therefore checked explicitly: a pass that fails to reduce the text
stops the loop and returns the section summaries, and the output file says that
is what happened. A `QuotaExceededError` mid-run halves that section and
continues rather than failing the whole transcript.

**That the summary is local is stated three times**, because a user who reads
only one of them still learns it: on the menu, in the confirmation dialog, and
as the first thing in the saved file — before the content, since a `.txt` gets
mailed and read months later by someone who never saw the dialog. The file
header also records when it was generated, from how many words, and in how many
sections and passes.

**Gates.** The summary is confirmed first, and the dialog names the one-time
~1.8 GB model download when it is needed, warns that the first run is slow, and
warns when a long transcript will take minutes. `requestSummary` reaches the
service synchronously inside the dispatch so it still carries the click's user
activation, which Chromium requires before a downloading `create()`. The
transcript download is not gated — saving text costs nothing.

**The summary controls are absent, not disabled, when the model cannot run.**
Presence of `self.Summarizer` is not a capability check: the object exists on
hardware below the Gemini Nano bar, where `availability()` answers
`"unavailable"` and every `create()` fails with "the service is not running". The
browser is asked at startup, and the whole summary section is omitted unless it
says yes.

Adds `selectTranscriptText` and `selectTranscriptWordCount` to
`@scribear/transcription-content-store`.

Pinned by unit tests — including a fake summarizer that enforces Chrome's real
token quota using the cost measured from the real API — and by
`npm run e2e:export`, which drives real Chrome and asserts the files that reach
the disk. The suite opts into the summary machinery explicitly so it keeps
working while the feature is off; a separate file pins the switched-off path,
including that nothing probes the browser or touches the model on page load.
