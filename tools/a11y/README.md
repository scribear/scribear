# Accessibility (WCAG 2.1 AA) tooling

Automated axe-core scan of the three ScribeAR webapps (client, kiosk, standalone),
driven by a headless system Chrome via `puppeteer-core`.

## Run

```bash
# Scan the local deploy_local nginx stack (https://localhost/{client,kiosk,standalone}/)
npm run a11y:axe

# Point at another origin
node tools/a11y/axe-scan.mjs https://staging.example.edu
```

Full per-route JSON is written to `tools/a11y/results/` (git-ignored). A summary of
violations (impact, rule id, help URL, offending selectors) prints to stdout.

Chrome is auto-detected from `CHROME_PATH`, then `/usr/bin/google-chrome-stable`,
`google-chrome`, `chromium-browser`, `chromium`.

## Getting past the lock screens — mock server + authed scan

`axe-scan.mjs` only ever sees each SPA's locked initial state. To scan the **real
interactive UI** (the caption `role="log"` region, the settings drawer, the
preference sliders, modals) you need to get past the join-code / device-activation
gates. Two tools do that, and they do **not** need the session-manager, node-server,
or transcription-service running — only *some* nginx (deploy_local or deploy_staging)
up to serve the static frontend bundles:

```bash
# 1. Start the mock backend (proxies the deployed bundles, fakes the session/device
#    REST API, and streams fake live captions over the transcription WebSocket).
npm run a11y:mock          # http://127.0.0.1:8090  (proxies https://localhost)

# 2. In another shell, drive each app past its gate and axe the resulting states.
npm run a11y:axe:authed    # writes tools/a11y/results/authed-*.json
```

`mock-server.mjs` also works for **manual** screen-reader / braille testing: open
`http://127.0.0.1:8090/client/` (use `127.0.0.1`, not `localhost`, to dodge HSTS),
type **any** join code, and fake captions stream into the live region — exactly the
P0 flow that needs NVDA/VoiceOver/Orca + a braille display. `.../kiosk/` accepts any
activation code. `.../standalone/` runs entirely client-side (no mock needed). Env
knobs are documented at the top of `mock-server.mjs`
(`PORT`, `UPSTREAM`, `MOCK_DEVICE_REGISTERED`, `MOCK_CAPTION_MS`, `MOCK_NO_CAPTIONS`).

> **Caveat — the authed scan reflects the *deployed* bundles, not your working tree.**
> The mock proxies whatever nginx is serving (the built images), so source-level a11y
> fixes in `libs/ui/*` / `apps/*` only show up after those frontends are rebuilt and
> redeployed (or after you point `UPSTREAM` at a local `vite preview`/`vite build`
> served on the same sub-paths). A finding here that matches a fix already in source
> just means the deployment is behind — re-run after a rebuild to confirm it clears.

## Important limitations (read before trusting a green run)

Automated tooling reliably catches only ~30–40% of WCAG 2.1 issues, and this
crawler only sees the **initial, unauthenticated state** of each SPA:

- **client** loads the Join-Session modal; the caption view and settings drawer
  are gated behind an active session (a valid join code), so axe never reaches them.
- **kiosk** sits on "Initializing…" until the device is activated (DEVICE_TOKEN cookie).
- **standalone** renders its main UI immediately, but a live provider / captions
  state is not exercised.

So a "0 violations" result means *the reachable static state is clean*, **not**
that the app is accessible. Full coverage requires:

1. **Component-level axe tests** — render each component (menus, sliders, modals,
   the caption container with `role="log"`) in `vitest` + `jsdom` and assert with
   `axe-core`. This reaches the interactive UI the crawler can't.
2. **Seeded end-to-end states** — drive a join code / device token, open the
   settings drawer, and re-scan.
3. **Manual review** — keyboard-only walkthrough and a screen-reader pass
   (NVDA/VoiceOver + a braille display for the live-caption region). See the
   `archived-plans/2026-07-24-02-PLAN-WCAG-Frontends.md` planning doc for the
   full checklist and the live-caption ARIA design, and the **Accessibility
   (WCAG 2.1 AA)** wiki page for day-to-day dev guidance.
