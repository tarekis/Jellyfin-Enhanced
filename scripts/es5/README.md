# ES5 build for old TV clients

Jellyfin Enhanced's client scripts are modern JavaScript. The LG webOS 3.x TV
web engine (Chromium 38; webOS 1–3 generally) only parses ES5, so on those TVs
the bundle fails with a `SyntaxError` before any module runs, and nothing of
the plugin appears in the official Jellyfin webOS app, even though that app
loads the server's web UI with the plugin's script tag in it.

`build.mjs` fixes that at build time. `dotnet build` runs it (see the
`JeBuildEs5`/`JeEmbedEs5` targets in `JellyfinEnhanced.csproj`), and the DLL
then embeds ES5 output in place of the sources, under the same resource names.
The C# serving code is unchanged.

| Input | Output |
| --- | --- |
| `js/**/*.js` | Babel (`@babel/preset-env`, target `chrome 38`), line numbers kept so the bundle's source map still lines up |
| inline `<script>` blocks of `PluginPages/*.html` and `Configuration/configPage.html` | the same transform |
| — | compatibility layer, minified and prepended to `js/plugin.js` |

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
npm run build:es5                 # -> Jellyfin.Plugin.JellyfinEnhanced/obj/es5
npm run test:frontend:es5         # the frontend suite against the ES5 output
npm run test:chromium38           # boots plugin.js + bundle in a real Chromium 38 (tests/es5/README.md)
dotnet build -p:JeEs5Build=false  # skip the transform: embeds the modern sources (needs no Node.js)
```

The build fails if any output file doesn't parse as ES5 (checked with acorn),
so modern syntax can't slip through.
