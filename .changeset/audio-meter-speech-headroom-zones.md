---
'@scribear/monitoring-sidecar': patch
'@scribear/scribear-nginx': patch
---

Default the standalone audio meter's peak zones to -12 / -3 dBFS.

The zone boundaries are applied to the held sample peak, but the defaults were
taken from EBU alignment level, which is an RMS convention. A sine at -18 dBFS
RMS peaks at -15.01 dBFS — 3 dB above the old warn boundary — so a correctly
levelled, perfectly healthy speech signal rendered amber. For a lecture-room
speech meter the boundary exists to guard headroom, which peak defines, so the
"speech headroom" preset already present in the meter's own zone selector is
the right default. Both alignment presets remain selectable.

nginx's pinned CSP hashes cover the meter page's inline scripts and were
recomputed to match.

The admin dashboard's `rmsDbfsHigh` (-6 dBFS) is deliberately unchanged: it is
an RMS threshold in a different system, and only its comment claimed parity
with the meter's peak default.
