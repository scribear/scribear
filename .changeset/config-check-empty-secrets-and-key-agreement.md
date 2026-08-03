---
'@scribear/admin-server': minor
---

Config Check reports secrets that are unset (not merely placeholder), proves
two cross-service keys actually agree, and names a down monitoring sidecar as
its own fault.

**Unset secrets were invisible.** `isPlaceholder('')` is `false` and the
placeholder loop skipped everything that was not a placeholder, so an empty
`ADMIN_API_KEY` or `DB_PASSWORD` produced no finding at all — silence
indistinguishable from a well-configured deployment. `describeSecret` had
carried a `'not set'` branch that nothing could reach. Both now have their own
findings, kept separate from the placeholder table because "not set" and "still
the example value" have different consequences and want different sentences.
`ADMIN_SESSION_SECRET` is excluded: it already had a dedicated missing-check
saying something more specific. `TEST_AUDIO_SERVICE_KEY` is excluded too, on
the grounds that its peer fails closed and names the variable itself, and that
whether the two agree is answerable by calling the generator rather than by
comparing a string here.

**Two non-placeholder keys that simply differ used to read green.** Nothing
verified that two services holding the same shared secret hold the _same_
value, and a placeholder audit cannot see this class of fault at all — it is
what a container recreated after an `.env` change, next to one that was not,
looks like. Two pairs are now proved, by the only mechanism the deployment
actually has: a party holding one copy presents it to the party holding the
other, and the rejection is the proof.

- `node-server-service-key-mismatch` — the sidecar polls node-server's
  `/status` every interval with its `NODE_SERVER_SERVICE_API_KEY`, and a 401
  becomes the `unauthorized` poll reason that `/config-audit` already relayed.
  That string was previously reported as one more way of _not knowing_, when it
  is the opposite: a proof about two configuration values. A rejection really
  is proof rather than a guess, because both other explanations are closed off
  — node-server refuses to construct with an empty or `CHANGEME` inbound key,
  and the sidecar does not poll at all with an empty one.
- `session-manager-admin-key-mismatch` — admin-server already presents
  `SESSION_MANAGER_API_KEY` to session-manager on every page of the console, so
  asking an admin-key-protected route and reading the status _is_ the
  comparison. Its own check rather than a branch of the schema-version read
  that makes the same call, because that one runs only after `dbClient.ping()`
  succeeds — a deployment with both faults is exactly the one that needs to be
  told they are separate. Silent when the key is unset (`admin-api-key-missing`
  is the better sentence) and when session-manager does not answer at all
  (`services-unreachable` already says so; only an actual 401/403 is evidence
  about a key).

No secret is moved to make either comparison, and no service is handed a
credential it did not already hold.

**`TRANSCRIPTION_API_KEY`, `NODE_SERVER_KEY` and `JWT_SECRET` remain
unverifiable at config time, deliberately and not by oversight.** Each is held
only by the two services that use it; neither exercises it until a real session
starts; and none reports the outcome when it does — a rejected
`TRANSCRIPTION_API_KEY` closes the upstream socket 1008 "Authentication Failed"
and node-server records only a generic upstream flap. Closing that gap needs a
new self-report from node-server, not another check here, and it is not faked
with an inference this page cannot stand behind. The class docblock says so
where the next reader will look.

**A down monitoring sidecar is now its own finding.** It was previously
inferable only as a side effect of `secret-placeholder-audit-unavailable`,
which named the wrong subject — an operator read "could not check
node-server-held secrets" and went to look at node-server, which was fine. The
sidecar is a core service that nothing else on this page covers (it is
deliberately absent from the health rollup's probe targets), and when it is
down the console's alerts panel goes blank at the same moment for the same
reason. `monitoring-sidecar-unreachable` enumerates what went _unchecked_
rather than leaving it implied — including the `NODE_SERVER_SERVICE_KEY` pair
above, which it is the sole source of evidence for. Sidecar down must never
read as "the keys agree". A sidecar that answers with a body Config Check
cannot parse or does not recognise keeps the existing
`secret-placeholder-audit-unavailable`: that is version skew, not an outage.
