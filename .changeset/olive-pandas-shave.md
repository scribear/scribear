---
'@scribear/kiosk-webapp': patch
'@scribear/client-webapp': patch
'@scribear/standalone-webapp': patch
---

Fix the web app manifests, which were still the favicon generator's
placeholders (`MyWebSite` / `MySite`) on all three caption apps.

Three defects, all shipping today:

- **PWA install had no icon on Android.** The manifest's icon paths were
  absolute, so they resolved to the site root and 404'd under the `/kiosk/`,
  `/client/` and `/standalone/` subpaths nginx serves the apps from. They are
  now relative to the manifest's own URL. iOS was unaffected — Add to Home
  Screen reads `apple-touch-icon`, which was already a relative path.
- **The install splash was white** while the caption theme is black.
- **The icons were declared `purpose: "maskable"`** but are not: the artwork is
  a speech bubble touching all four edges on a transparent background, whereas
  a maskable icon needs an opaque full-canvas background with its content
  inside the inner 80%. Android was cropping the bubble's edges and tail off.
  They are now `purpose: "any"`. A purpose-built maskable variant would still
  be worth commissioning for a better Android tile.

The three apps also now have distinct names and home-screen labels, so
installing more than one no longer produces indistinguishable tiles.

Adds `apple-mobile-web-app-capable`, so iPadOS before 16.4 opens the app from
the home screen without Safari chrome. This is **install hygiene, not a fix for
the caption auto-scroll bug**: removing the chrome removes one source of
viewport resize, but rotation, Split View, Stage Manager, the split-pane
divider and display-preference changes all resize a standalone window exactly
as they do a browser tab — and a kiosk pinned under Guided Access or MDM has no
Safari chrome to remove in the first place.

Adds `theme-color`, which also recolours the toolbar on ordinary Android Chrome
visits, not only installed ones. Intended: these are black caption apps.
