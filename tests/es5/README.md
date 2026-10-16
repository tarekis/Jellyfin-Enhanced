# Chromium 38 smoke test

`chromium38-smoke.mjs` boots `plugin.js` plus the component bundle in a real Chromium 38
(the engine of LG webOS 3.x) against a local mock server that serves the client the way the
plugin does (`/JellyfinEnhanced/script`, `/bootstrap`, `/bundle.js`, `/js/...`, `/locales/...`),
and reports uncaught errors, console errors/warnings, bundle progress (`__JE_BUNDLE_PROGRESS`
vs `__JE_BUNDLE_TOTAL`), `JellyfinEnhanced.initialized` and every request path. Exit code 0 only if
there are no uncaught errors, the bundle fully ran and `initialized` is true.

    export JE_CHROME38=/path/to/chrome-linux/chrome
    export JE_CHROME38_LIBS=/path/to/extra/libs
    node scripts/es5/build.mjs                       # ES5 output in Jellyfin.Plugin.JellyfinEnhanced/obj/es5
    npm run test:chromium38                          # ES5 build (default)
    node tests/es5/chromium38-smoke.mjs --src Jellyfin.Plugin.JellyfinEnhanced/js   # original sources

Chromium 38 speaks the old DevTools protocol, so Playwright/puppeteer cannot drive it; the script
talks to it directly over the remote-debugging WebSocket and launches it under `xvfb-run`.

## Getting Chromium 38

Build 290027 (38.0.2125.0) from the chromium-browser-snapshots bucket:
`https://storage.googleapis.com/chromium-browser-snapshots/Linux_x64/290027/chrome-linux.zip`.
Unzip it, then provide the libraries it needs (put them in one directory = `JE_CHROME38_LIBS`):

- `libgconf-2.so.4`: from Ubuntu jammy's `libgconf-2-4` deb (extract, do not install)
- `libudev.so.0`: symlink to the system `libudev.so.1`
- `libgtk2.0-0t64`, `libdbus-glib-1-2`, `xvfb` installed from the distro packages

`--seerr` adds a Seerr scenario: fake jellyfin-web search page, types "dune", expects 3 Seerr cards, opens a poster overview, clicks Request and asserts the `POST /JellyfinEnhanced/jellyseerr/request` body; also sends a real Enter key to a focused poster.
