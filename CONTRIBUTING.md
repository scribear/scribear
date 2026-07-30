# Contributing

Setup, architecture and API reference live in the
**[wiki](https://github.com/scribear/scribear/wiki)**; branch and release
mechanics live in [`RELEASING.md`](RELEASING.md). This file is for something the
wiki does not cover: the mistakes this codebase has actually made, written down
as rules so they are not made again.

Each rule below is here because it cost real debugging time on this repo. The
evidence is kept with the rule — a rule without its incident tends to get
optimised away by the next person who finds it inconvenient.

## Reviewing monitoring, alerting and scheduling code

### Assume every guard is censored by the fault it detects

**Any guard, floor, denominator, fallback label, or capacity estimate should be
assumed censored under the exact condition it exists to detect, until proven
otherwise.**

When you write a threshold, ask what happens to *the inputs of the threshold
itself* during the failure. Five instances of this in this repo's monitoring
code, all found after the fact:

- A tail-latency rule required 100 *passes* in its window before it would fire.
  Dropping a period is precisely what removes a pass, so the floor climbed out of
  reach exactly as the fault got severe.
- `UNLABELED_PROVIDER = "unknown"` was commented "should stay near zero". It took
  **100%** of drops during a saturation collapse, because the label is lost by
  deregistration and mass deregistration *is* what a collapse looks like.
  Meanwhile the `whisper` series showed a perfectly healthy provider during a
  total outage.
- A capacity estimator's naive form would *raise* the ceiling as the service
  collapsed, because measured per-session cost stops rising once busy pegs at
  1.0. (Caught at design time; the ratchet is the fix.)
- `CapacityEstimator.clean_samples` never advances for a worker degraded from its
  first session, so it never leaves warm-up and `admit()` returns `True` forever.
- A service key left at its `CHANGEME` default can never surface as its own
  config-check finding, because that key guards the endpoint that would report
  it.

### Check which direction your metric moves under the failure

Before alerting on a metric, confirm its slope under the fault. `asr_rtf`
*falls* as transcription saturates — an alert written for "RTF goes up when
things get bad" never fires.

Corollary: **when you replace a metric because its slope was wrong, audit the
guards and denominators around it for the same error.** They were written in the
same sitting by the same reasoning and are wrong the same way.

### Metrics that nothing consumes are not monitoring

A counter that is defined, incremented and exported but has no series, alert,
dashboard panel or UI is a comment with a performance cost. Either wire it to a
consumer in the same change, or don't add it.

## Merging long-lived branches

### A clean merge of a moved file is the highest-risk case, not the lowest

**When a long-lived branch *extracts* or *moves* code into new files, the moved
copy is a snapshot of the fork point — and merging it silently reverts
everything that landed in the original since.**

Because the extracted files are *new paths*, git merges them with **zero
conflicts** and says nothing. This happened here: a branch forked, pulled five
dialogs out of `room-scheduling-page.tsx` into standalone files, and meanwhile
five commits modified that same dialog code on `staging` (a MUI major upgrade,
a set of WCAG fixes, a lazy-initial-state cleanup, a set-state-in-effect
migration, and an ESLint major bump). Measured: `daysError` — a shipped WCAG 2.1
AA fix that replaced toast-only validation with a persistent inline field error —
appeared 6 times in `staging`'s version and 0 times in the extracted files. A
closed accessibility finding was being silently re-opened.

**Detection, because review will not catch it:** for any file a branch deletes or
guts, run

```sh
git log <fork-point>..<target-branch> -- <that-file>
```

and check every commit in that range against wherever the code went. Conflict
count is not a measure of merge risk.

## Protocols and cross-service schemas

### Auth is a property of the connection, not the session

**Any credential sent once per socket is a bug if the client can reconnect.**
Three clients here spoke the same protocol; one used `onHandshake` and was
immune, the other two sent auth from `on('open')` and broke on every *second*
connection. It was invisible in testing because the WS client reconnects
silently.

### New fields in a published schema are `Type.Optional`

**Every field added to a cross-service published schema must be `Type.Optional`
unless both sides ship atomically.** A required field in a Redis-published
telemetry schema means the whole snapshot fails strict validation and the node
*vanishes from the dashboard* for the length of a rolling deploy — the dashboard
you would be watching during that deploy.

### Reject bad input by dropping and counting, not by closing

Killing a connection on unexpected input (e.g. binary before auth) turns a
recoverable client bug into a silent outage: the client reconnects, fails the
same way, and nothing names the cause. Drop the offending data, increment a
counter that is actually consumed, and let the connection live.

## Testing

### A feature with a "currently active" notion needs a fixture that is active now

Every session-manager fixture used a far-future window in a room with
`autoSessionEnabled: false`. That is how a 500 that broke *every* on-demand
session in *every* auto-enabled room survived **341 passing integration tests**.
If the feature has a notion of "live", at least one fixture must be live at the
moment the suite runs.

### Deterministic ordering needs a tiebreak

Rows created inside the same millisecond tie on a `created_at` cursor, and the
resulting test fails a couple of runs in ten. Any keyset/cursor pagination needs
a unique tiebreak column in both the `ORDER BY` and the cursor.

### In a monorepo with shared schema packages, the schema change is the blast radius

Run the **root** build and unit tests, not the workspace's, when you touch
anything under `libs/schemas` or another shared package.

### A commit can pass every local check and still not build

Typecheck, lint and tests all read the **filesystem**, not the git index — so an
un-`git add`ed directory is invisible to all of them and CI is the first thing to
see it. `git status` after committing is the check.

## Working with AI coding agents

These are here because this repo is developed with agents and they fail in
specific, repeatable ways.

- **A background agent reporting "completed" is a claim about its own turn
  ending, not proof the task finished.** One reported success having built ten
  images and never run `docker compose up`. Verify a delegated task's *end
  state*, not its self-report.
- **A working tree is shared mutable state between concurrent agents.** An agent
  reading a checkout during a two-minute commit-split correctly reported that an
  entire feature had vanished. Do that kind of surgery in a scratch clone or
  behind a stash.
- **Reading a peer branch's diff is often worth more than either branch's own
  review.** Two independent investigations here converged on the same root cause
  and each had built something the other hadn't.

## Accessibility

The admin console and the webapps are held to WCAG 2.1 AA. Two repo-specific
traps:

- **MUI's `Typography` maps `variant="subtitle2"` to an `<h6>` *element*** via
  the default `variantMapping`, whether or not the text is a heading. Decorative
  or label text using `subtitle2` silently enters the document outline at level
  6, which under an `h1`/`h2` page is a `heading-order` violation. Pass
  `component="p"` or `component="span"` on any `subtitle2`/`subtitle1` that is
  not a real section heading.
- `npm run a11y:axe` (and `a11y:axe:authed`) run the automated sweep, but a
  handful of findings — live-region announcements, small-viewport reflow — can
  only be closed by a human with a screen reader. Automated pass is not the same
  as done.
