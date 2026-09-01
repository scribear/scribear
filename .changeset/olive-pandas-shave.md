---
'@scribear/kiosk-webapp': patch
'@scribear/client-webapp': patch
'@scribear/standalone-webapp': patch
---

Fix the web app manifests so an iPad home-screen install works.

The manifests were the favicon generator's placeholders. Their icon paths were
absolute and so 404'd under the /kiosk/, /client/ and /standalone/ subpaths
nginx serves the apps from, leaving Add to Home Screen with no icon; and the
splash colours were white while the caption theme is black. Also adds
`apple-mobile-web-app-capable` so iPadOS before 16.4 opens the app without
Safari chrome — a chrome-free window is a viewport that does not resize
underneath the captions while someone is reading them.
