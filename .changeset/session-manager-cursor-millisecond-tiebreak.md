---
'@scribear/session-manager': patch
---

Fix cursor pagination repeating rows created inside the same millisecond.

`_listByCreatedAt` filtered on `date_trunc('milliseconds', created_at)` but
ordered on the raw column. `created_at` is a `timestamptz` and keeps
microseconds, while the cursor round-trips through a JS `Date` and an ISO-8601
string and can only ever name a millisecond — so for rows sharing a
millisecond the ordering and the filter disagreed about which side of the
cursor a row fell on. A row ordered into page N by its microseconds could
still satisfy the `uid` tiebreak and be returned again on page N+1.

Both the device and room repositories now order on the same truncated
expression their cursor predicate uses. This was the cause of the
intermittent `list-devices` / `list-rooms` pagination test failures; both
suites gained a regression test that forces the collision rather than waiting
for it.
