---
'@scribear/session-manager': minor
---

Recalibrate the session-auth rate limits, and add the anti-guessing control the
old limit was pretending to be.

`exchange-join-code` and `refresh-session-token` were limited at a hard-coded
100 requests / 60 s per client IP. That number was set as if it were a
credential-guessing defence, and it is not one: join codes are 8 characters from
a 36-character alphabet (~2.8×10¹² possibilities) rotating every 5 minutes, and
refresh tokens are 256-bit secrets checked against the database, so brute force
is hopeless at 100/min and equally hopeless at 100,000/min. What it did instead
was fire on ordinary traffic. Session tokens live 5 minutes and the client
refreshes at 50% of remaining lifetime, so each viewer refreshes about every
150 s; `N` viewers behind one NAT produce `N/150` refreshes per second, which
crosses `100/60 s` at **N ≈ 250**. A 250-seat hall behind one campus NAT was
429ing continuously in steady state with nobody doing anything unusual, and
`exchange-join-code` tripped earlier still.

The limits now live in `AppConfig` (`SESSION_AUTH_RATE_LIMIT_*`), as
admin-server's already do, with the calibration argument written down beside
them:

- **`refresh-session-token`: 1,000 / 60 s.** Covers ~2,500 viewers behind one
  egress IP in steady state. Raised rather than exempted, because this is the
  most expensive unauthenticated call in the service — one bcrypt cost-12
  compare, measured at 154 ms of libuv threadpool, against a service-wide
  ceiling of ~25 compares/s with the default 4-thread pool — and because a
  single client has already been seen hammering it in an unbounded ~1 s loop
  (the reason `REFRESH_MAX_CONSECUTIVE_FAILURES` exists in client-webapp).
  1,000 / 60 s is ~17× that runaway rate and ~2.5× the largest lecture hall.
- **`exchange-join-code`: 600 / 60 s.** A generous volumetric cap: a 1,000-seat
  hall can join inside ~100 s without touching it, while 600 *successful* joins
  a minute is ~1.5 of the 4 bcrypt threads held by one source.
- **New: 100 failed exchanges / 60 s.** The actual anti-guessing control, and
  the operator's signal that guessing is happening (blocks are logged with the
  client IP).

The failed-attempt cap is keyed on the **client IP, never on the submitted join
code** — keying a limiter on the credential being guessed hands the guesser a
fresh bucket per guess, which is worse than having no limiter. It counts only
404 `JOIN_CODE_NOT_FOUND`; a successful join never spends from it, so a full
hall cannot lock itself out by joining normally. `@fastify/rate-limit` cannot do
outcome-conditional counting through `config.rateLimit`, so this uses
`fastify.createRateLimit()` (v11's manual API): a `preHandler` peeks with
`{ increment: false }` and an `onSend` hook charges with `{ increment: true }`
only on a 404. `onSend` rather than `onResponse`, so a burst of concurrent
guesses cannot all clear the peek before any of them is charged.

410 `JOIN_CODE_EXPIRED` is deliberately **not** charged: a guesser essentially
never produces one, whereas a stale code left on a projector makes a whole room
produce one at the same instant, and charging that would lock the room out of
joining even after the display is fixed.

The 429 declarations and user-facing wording added alongside them are unchanged
and remain accurate. Because the limits are now config, the rate-limit
integration suite configures a tiny limit instead of spending 100 real requests
per route to reach a hard-coded ceiling and then leaving both routes limited for
the remainder of a real 60-second window.
