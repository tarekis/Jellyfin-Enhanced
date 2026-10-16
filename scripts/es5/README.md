# ES5 compatibility layer for old devices

Jellyfin Enhanced's client scripts are modern JavaScript. Some devices'
web engines only parse ES5. One example is the LG webOS 3.x TV, Chromium 38,
and webOS 1–3 generally. On those devices the bundle fails with a
`SyntaxError` before any module runs, and nothing of the plugin appears, for
example in the official Jellyfin webOS app, even though that app loads the
server's web UI with the plugin's script tag in it.

The admin setting **Admin → Compatibility → ES5 compatibility layer for old
devices** (`Es5CompatibilityMode`, off by default) fixes that by serving an ES5
build of the scripts instead.

## Build

`build.mjs` produces the ES5 build. It's opt-in at build time: a plain
`dotnet build` leaves it out and needs no Node.js, and the setting then has no
effect. Release builds (`.github/workflows/release.yml`) and the backend CI
job pass `-p:JeEs5Build=true`. That runs `build.mjs` (see the
`JeBuildEs5`/`JeEmbedEs5` targets in `JellyfinEnhanced.csproj`), and the DLL
embeds the output **next to** the original resources, Brotli-compressed under
the `es5.` resource prefix (`Jellyfin.Plugin.JellyfinEnhanced.es5.js.….br`). The
original resources are unchanged. Compressed, the second copy adds about
0.9 MB to the DLL: the ES5 modules are ~0.80 MB, the compatibility layer
~0.09 MB. The server decompresses a script when it serves it.

| Input | Output |
| --- | --- |
| `js/**/*.js` | Babel (`@babel/preset-env`, target `chrome 38`), line numbers kept so the bundle's source map still lines up |
| inline `<script>` blocks of `PluginPages/*.html` | the same transform |
| — | compatibility layer, minified and prepended to `js/plugin.js` |

The admin configuration page is served by Jellyfin itself, not by the plugin,
and always keeps its regular scripts.

## Serving

`Services/ClientScriptVariant.cs` decides per request. With the setting on and
the ES5 resources present, these all return the decompressed `es5.` resource:

* `/JellyfinEnhanced/script`
* `/JellyfinEnhanced/js/*`
* `/JellyfinEnhanced/bundle.js` (every module)
* the plugin pages

Everything else (locales, fonts, JSON, CSS) is shared. The script cache key
gets an `-es5` suffix, so switching the setting changes every script URL, and
clients load the other build on their next page load instead of a cached copy.
With the setting off, the responses are byte-for-byte what they were before.

`plugin.js` is the script the server injects into `index.html`. It runs
before every other client script, so the layer is in place for the bundle, the
per-file fallback loader and the plugin pages alike.

## Compatibility layer

* **core-js**: every ECMAScript/web built-in Chromium 38 lacks (`Promise`
  statics, `Map`/`Set`, `Object.entries`, `Array.prototype.includes`,
  `URLSearchParams`, `structuredClone`, `queueMicrotask`, NodeList iteration, …).
  It is the complete set for the target, not just the usage-detected one:
  core-js replaces some natives wholesale, and a replaced constructor only gets
  the static methods whose modules are included.
* **DOM polyfills**: `whatwg-fetch`, `abortcontroller-polyfill`,
  `intersection-observer`, `@juggle/resize-observer`, `css.escape`.
* **`dom-shims.js`** (hand-written, feature-detected, no-ops on current
  browsers):
  * `closest`/`matches`
  * `append`/`prepend`/`replaceChildren`/`before`/`after`/`replaceWith`
  * `isConnected`, `getRootNode`, `getAttributeNames`, `toggleAttribute`
  * DOMRect `x`/`y`, `document.scrollingElement`
  * `scrollTo`/`scrollBy`/`scrollIntoView` with an options object
  * `addEventListener` options objects (`once`, `signal`, `capture`; an old
    engine would read the object as `useCapture = true`)
  * `MediaQueryList.addEventListener`, `new EventTarget()`, `PointerEvent`
  * `DOMTokenList` force/multi-token
  * `Intl.DisplayNames` (callers fall back to the code)
  * `KeyboardEvent.key`/`code` from `keyCode`. TV remotes only send
    `keyCode`, and the plugin compares `event.key`.
* **`css-vars.js`**: `css-vars-ponyfill` for the plugin's `<style>` elements
  (`var(--…)` needs Chromium 49), only where CSS variables are unsupported.
* **Babel helpers**: shared once as `babelHelpers` instead of being inlined
  into each of the ~170 modules.

`requestIdleCallback` is deliberately not shimmed: every caller already falls
back to its own `setTimeout`.

## Known limits on Chromium 38

Visual only, nothing that stops a feature from loading. These CSS features
can't be polyfilled cheaply and degrade on these engines:

* flexbox `gap` (Chromium 84): items sit without spacing
* `:has()`/`:where()`: those rules are dropped
* `clamp()`, `inset`, `aspect-ratio`, `backdrop-filter`, `color-mix()`
* `position: sticky`
* 8-digit hex colours

Pointer events don't exist there, so pointer-only handlers don't fire. Mouse
and keyboard handlers do.

## Commands

```sh
npm ci
npm run build:es5                                # -> Jellyfin.Plugin.JellyfinEnhanced/obj/es5
npm run test:frontend:es5                        # the frontend suite against the ES5 output
npm run test:chromium38                          # boots plugin.js + bundle in a real Chromium 38 (tests/es5/README.md)
dotnet build -c Release -p:JeEs5Build=true       # a plugin DLL with the ES5 build embedded, as released
JeEs5Build=true JE_REQUIRE_ES5=1 python3 tests/run.py backend --target jf12   # backend tests incl. the ES5 ones
```

The build fails if any output file doesn't parse as ES5 (checked with acorn),
so modern syntax can't slip through.
