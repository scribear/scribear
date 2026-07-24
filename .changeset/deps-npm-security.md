---
'@scribear/admin-server': patch
'@scribear/node-server': patch
'@scribear/session-manager': patch
'@scribear/monitoring-sidecar': patch
---

Clear the open high-severity npm security advisories.

- **fast-uri** → 3.1.4 / 4.1.1 — host confusion via a literal backslash
  authority delimiter (GHSA-v2hh-gcrm-f6hx). Shipped transitively through
  Fastify by the four server apps listed here.
- **brace-expansion** → 1.1.16 / 2.1.2 / 5.0.7 — quadratic-complexity DoS.
- **shell-quote** → 1.9.0 via an `overrides` entry (quadratic DoS in
  `parse()`); `concurrently` pins the vulnerable 1.8.4 and has no fixed release,
  so an override is the only route that does not downgrade concurrently.

Lockfile / dev-tooling only — no workspace package's own dependencies changed.
`npm audit` reports 0 vulnerabilities; workspace unit tests and `npm run build`
pass.
