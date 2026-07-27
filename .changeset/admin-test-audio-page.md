---
'@scribear/admin-webapp': minor
---

Admin console — **Test audio**: two synthetic source devices an operator can
point at a test room and parameterize live, so an alert can be seen before it
matters (`PLAN-TestAudioDevices.md` §4).

- **Two cards, one per device.** The *good source* plays clean speech with a
  clip selector, a gain slider whose ends are labelled with what they mean
  (−40 dB is below the ingress meter's silence floor, +20 dB is hard clipping),
  a noise-type toggle and five fixed noise-floor levels. The *fault source*
  carries one slider per fault — clipping, stutter, drops, send-rate multiple,
  digital silence, DC bias, corrupt frames, bad WAV headers and clock skew —
  each captioned with what it is expected to trip, so the page doubles as the
  documentation for §2.2's table rather than sending the reader to the plan.
- **The captions name real identifiers, and say when there are none.** Every
  metric and alert id printed on the page was checked against the sidecar's
  alert rules and metrics registry: the metric names carry the `scribear_`
  prefix the plan's table omits, `dcOffset` has no telemetry measuring it
  anywhere and says so, and `stutterPct` is captioned against caption
  repetition because node-server does not count duplicate chunk ids.
- **Live retune.** Changing a control on a running device `PATCH`es the knob
  that moved — the stream and its session survive, which is the point of
  turning a knob and watching a meter. On an idle device the same change is
  local state, applied at start. The device list polls every 3 s while the tab
  is visible and refreshes immediately on becoming visible again.
- **A deployment that never provisioned the devices sees an explanation**, not
  an error: the page names `TEST_AUDIO_BASE_URL` and the provisioning script
  instead of raising a toast, and a device with no token reports why it cannot
  be started. The page also states the safety boundary up front — a device
  token only reaches sessions in its own device's room, so neither source can
  stream into a teaching room.
- Every control has an accessible name that distinguishes the two sources, the
  sliders carry unit-bearing `getAriaValueText`, the run state is the only
  live region (the counters move every poll and would be unusable if
  announced), and the page is covered by a `jest-axe` assertion.
