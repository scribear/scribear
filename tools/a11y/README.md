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
   `PLAN-WCAG-Frontends.md` planning doc for the full checklist and the
   live-caption ARIA design, and the **Accessibility (WCAG 2.1 AA)** wiki page
   for day-to-day dev guidance.
