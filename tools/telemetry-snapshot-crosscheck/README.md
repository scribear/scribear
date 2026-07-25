# Telemetry snapshot cross-check

`transcription-host-snapshot.json` is the payload
`RedisTelemetryPublisher.publish_once` writes for a **loaded** Transcription
Service host, emitted by that publisher rather than written by hand.

It exists because of a bug that survived from the day the schema was written.
`TRANSCRIPTION_HOST_SNAPSHOT_SCHEMA` declared

```ts
contextIds: Type.Array(Type.String())
```

while `worker_view.serialize_worker` has always emitted
`sorted(snapshot.context_ids)` of a `set[int]` — an array of integers. Nothing
caught it, and a green test suite could not have: the fixtures in the schema's
own package and in `admin-server` were written *from* the schema, so they
agreed with it perfectly. The schema's fixture even used
`['faster-whisper', 'silero']`, context *tags*, which the publisher has never
been able to produce. The monitoring sidecar, which restates the same endpoint
by hand, had it right all along.

**So the oracle here is the other implementation, never a fixture.**

## The two legs, and why neither is sufficient

| Leg | Suite | Asserts |
|---|---|---|
| Live | `apps/node-server/tests/integration/features/telemetry/publisher-schema-crosscheck.test.ts` | the shipped image's publisher, writing to a real Redis over a real network, produces bytes `parseTranscriptionHostSnapshot` accepts — and node-server's own two record types likewise |
| Manifest | `transcription_service/.../telemetry/host_snapshot_crosscheck_test.py` + `infra/scribear-redis/tests/unit/transcription-host-crosscheck.test.ts` | this file equals what the publisher serializes (Python side), and parses under the reader's schema (TypeScript side) |

The live leg covers the real transport and cannot reach the nested shapes: a
debug-only provider configuration loads no model context, so `contextIds`,
`owningWorkers` and `activeJobs` are all `[]` on the wire — and **an empty
array satisfies any element type at all**. Restoring the historical
`Type.Array(Type.String())` bug passes the live leg. That is measured, not
assumed.

The manifest leg reaches those shapes without needing a model, because
`serialize_worker` is the single function both `/metrics/status` and
`/providers/health` serialize workers through: driving the real publisher over
a populated report produces exactly the bytes a loaded host would write. It
covers no transport at all.

## What the manifest deliberately contains

Every field a debug-only host leaves empty is non-empty here:

- **two model contexts on a worker**, so `contextIds`' element type is
  exercised. The set is `{8, 1}`, not the obvious `{0, 1}`: CPython iterates a
  set of small ints in slot order, which for `{0, 1}` is already sorted, so
  that set cannot distinguish `sorted(...)` from `list(...)`. With `{8, 1}` a
  publisher that dropped the sort fails; with `{0, 1}` it passes. A fixture
  chosen for readability is not automatically a fixture that can fail.
- **a dead worker** (`alive: false`) — the B1.3 state where jobs registered to
  a worker neither return nor raise.
- **active jobs both correlated and not**, because the schema declares those
  uids nullable rather than optional, and only a null on the wire tests that.
- **one provider of every `kind`** — `local`, `remote`, `debug`, `unknown` —
  so each nullable field appears in both its populated and its null state.
  A manifest carrying only `debug` would leave `model`, `modelLoaded`,
  `endpoint`, `reachable` and `probeLatencyMs` null everywhere, and
  `Type.Union([X, Type.Null()])` is satisfied by null whatever `X` is.

Mutation-checked in both directions. Retyping `contextIds`, `jobId` or
`activeJobs[].sessionUid`, or dropping `'unknown'` from the `kind` union, each
fails the TypeScript leg; renaming a key or dropping the `sorted(...)` in the
publisher each fails the Python leg.

## Editing it

Don't. Regenerate it from the publisher and commit the result — the Python leg
asserts the committed file still equals what `publish_once` emits, so a
hand-edit made to satisfy the TypeScript leg is exactly the failure this
cross-check exists to prevent. `updatedAt` is stamped from the wall clock and
is the one field the Python leg overwrites before comparing.

## What it does not cover

`providerUid` is typed `str | None` in Python
(`ProviderHealthEntry.provider_uid`, read with `.get()`) and non-nullable in
both TypeScript mirrors. The null is unreachable today — `_provider_uids` and
`self._providers` are built from the same config dict, so the `.get` cannot
miss — and the stricter schema is the right one, so the invariant is asserted
in Python (`test_a_configured_provider_always_has_a_uid`) rather than the
schema being loosened to match a state that cannot occur. If that invariant
ever breaks, the reader will hard-drop the host.
