#!/usr/bin/env node
// ES5 build for the client scripts.
//
// Old devices (e.g. LG webOS 3.x TVs = Chromium 38) only parse ES5, so one
// modern file is enough for the whole component bundle to fail with a
// SyntaxError and nothing of Jellyfin Enhanced appears. This transpiles every
// client script (js/**/*.js and the inline <script> blocks of the plugin
// pages) to ES5 with Babel and writes them to an output directory that the
// .csproj embeds next to the originals under the "es5." resource prefix. The
// server serves them only while the admin setting Es5CompatibilityMode is on.
//
// Polyfills: the core-js modules Babel detects as used, plus the DOM shims in
// ./dom-shims.js and a few DOM polyfill packages, are bundled once and put in
// front of js/plugin.js, which the server injects into index.html and which
// loads before every other client script.
//
// Usage: node scripts/es5/build.mjs [--project <dir>] [--out <dir>]

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const babel = require('@babel/core');
const esbuild = require('esbuild');
const acorn = require('acorn');

// Oldest engine the client scripts must run on. Keep in sync with the README.
export const TARGETS = 'chrome 38';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');

function arg(name, fallback) {
    const i = process.argv.indexOf(name);
    return i > -1 && process.argv[i + 1] ? path.resolve(process.argv[i + 1]) : fallback;
}

const projectDir = arg('--project', path.join(repoRoot, 'Jellyfin.Plugin.JellyfinEnhanced'));
const outDir = arg('--out', path.join(projectDir, 'obj', 'es5'));

// Inline <script> blocks of the plugin pages (served by the plugin's own
// controller). The admin config page is served by Jellyfin itself, so it keeps
// its modern scripts.
const HTML_PAGES = fs.readdirSync(path.join(projectDir, 'PluginPages'))
    .filter((f) => f.endsWith('.html'))
    .map((f) => `PluginPages/${f}`);

// Every core-js module Chromium 38 needs, not only the ones usage detection
// finds: core-js replaces some natives wholesale (Promise, Map, ...), and a
// replaced constructor only has the static methods whose modules are included.
function coreJsForTargets() {
    const { code } = babel.transformSync(`import 'core-js/stable';`, {
        babelrc: false,
        configFile: false,
        sourceType: 'module',
        plugins: [[require.resolve('babel-plugin-polyfill-corejs3'), {
            method: 'entry-global',
            version: require('core-js/package.json').version,
            targets: TARGETS,
        }]],
    });
    return [...code.matchAll(/core-js\/modules\/([\w.-]+)\.js/g)].map((m) => m[1]);
}

const CORE_JS_REQUIRE = /require\("core-js\/modules\/([\w.-]+)\.js"\);/g;

function walk(dir, base = dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        return entry.isDirectory() ? walk(full, base) : [path.relative(base, full).split(path.sep).join('/')];
    });
}

function assertEs5(code, label) {
    try {
        acorn.parse(code, { ecmaVersion: 5, sourceType: 'script', allowReserved: true, allowHashBang: false });
    } catch (error) {
        const lines = code.split('\n');
        const line = error.loc ? lines[error.loc.line - 1] || '' : '';
        const col = error.loc ? error.loc.column : 0;
        throw new Error(`${label}: output is not ES5 (${error.message})\n  ${line.slice(Math.max(0, col - 80), col + 80)}`);
    }
}

const coreJsUsed = new Set(coreJsForTargets());
const helpersUsed = new Set();

function transpile(code, filename) {
    const result = babel.transformSync(code, {
        babelrc: false,
        configFile: false,
        filename,
        sourceType: 'script',
        // Keep line numbers so the server's line-identity source map for
        // bundle.js still points at the right source lines.
        retainLines: true,
        comments: true,
        compact: false,
        presets: [[require.resolve('@babel/preset-env'), { targets: TARGETS, modules: false }]],
        plugins: [
            // helperVersion: without it every helper newer than 7.0.0-beta.0 is inlined
            // at the top of the file, outside the module's IIFE.
            [require.resolve('@babel/plugin-external-helpers'), { helperVersion: babel.version }],
            [require.resolve('babel-plugin-polyfill-corejs3'), {
                method: 'usage-global',
                version: require('core-js/package.json').version,
            }],
        ],
    });

    // Polyfills are collected and shipped once in front of plugin.js instead.
    let out = result.code.replace(CORE_JS_REQUIRE, (_, mod) => {
        coreJsUsed.add(mod);
        return '';
    });
    for (const match of out.matchAll(/\bbabelHelpers\.(\w+)/g)) {
        helpersUsed.add(match[1]);
    }
    if (/\brequire\(/.test(out) && /\brequire\("[^"]*(core-js|regenerator|@babel)/.test(out)) {
        throw new Error(`${filename}: Babel left a module require() in the output`);
    }
    assertEs5(out, filename);
    return out;
}

function transpileHtml(html, filename) {
    let index = 0;
    return html.replace(/<script(\s[^>]*)?>([\s\S]*?)<\/script>/gi, (whole, attrs = '', body) => {
        index++;
        if (/\ssrc\s*=/i.test(attrs) || !body.trim()) return whole;
        const type = /\stype\s*=\s*["']?([^"'\s>]+)/i.exec(attrs);
        if (type && !/^(text|application)\/(javascript|ecmascript)$/i.test(type[1])) return whole;
        return `<script${attrs}>${transpile(body, `${filename}#script${index}`)}</script>`;
    });
}

async function buildPolyfills() {
    const entry = [
        ...[...coreJsUsed].sort().map((mod) => `import 'core-js/modules/${mod}.js';`),
        // fetch must exist before abortcontroller-polyfill patches it for `signal`.
        `import 'whatwg-fetch';`,
        `import 'abortcontroller-polyfill/dist/abortcontroller-polyfill-only';`,
        `import 'intersection-observer';`,
        `import { ResizeObserver as JuggleResizeObserver } from '@juggle/resize-observer';`,
        `if (!window.ResizeObserver) window.ResizeObserver = JuggleResizeObserver;`,
        `import 'css.escape';`,
        `import './dom-shims.js';`,
        `import './css-vars.js';`,
    ].join('\n');

    const bundled = await esbuild.build({
        stdin: { contents: entry, resolveDir: here, sourcefile: 'polyfills-entry.js' },
        bundle: true,
        write: false,
        format: 'iife',
        target: 'es2015',
        nodePaths: [path.join(repoRoot, 'node_modules')],
        logLevel: 'error',
    });

    const polyfillCode = babel.transformSync(bundled.outputFiles[0].text, {
        babelrc: false,
        configFile: false,
        sourceType: 'script',
        compact: false,
        presets: [[require.resolve('@babel/preset-env'), { targets: TARGETS, modules: false }]],
    }).code;
    assertEs5(polyfillCode, 'polyfills');

    // Babel's shared helpers; a helper can depend on other helpers, so the
    // allowlist is grown until it stops changing.
    let helpers = '';
    for (let size = -1; size !== helpersUsed.size;) {
        size = helpersUsed.size;
        helpers = babel.buildExternalHelpers([...helpersUsed], 'global');
        for (const match of helpers.matchAll(/\bbabelHelpers\.(\w+)/g)) helpersUsed.add(match[1]);
    }
    const helpersEs5 = babel.transformSync(helpers, {
        babelrc: false,
        configFile: false,
        sourceType: 'script',
        presets: [[require.resolve('@babel/preset-env'), { targets: TARGETS, modules: false }]],
    }).code;
    assertEs5(helpersEs5, 'babel helpers');

    // Guarded so a second evaluation (plugin.js loaded twice) can't wrap the
    // shims around themselves. Minified: it is about 1 MB as written, a lot to
    // parse for a TV; the modules stay readable (and line-aligned) below it.
    const layer = [
        'if (!window.__jeEs5Compat) {',
        'window.__jeEs5Compat = true;',
        polyfillCode,
        helpersEs5,
        '}',
    ].join('\n');
    const minified = (await esbuild.transform(layer, { minify: true, target: 'es5', legalComments: 'eof' })).code;
    assertEs5(minified, 'minified compatibility layer');
    return [
        '/* Jellyfin Enhanced ES5 compatibility layer: polyfills + Babel helpers (scripts/es5/build.mjs) */',
        minified.trimEnd(),
        '',
    ].join('\n');
}

async function main() {
    const started = Date.now();
    const jsFiles = walk(path.join(projectDir, 'js')).filter((f) => f.endsWith('.js'));
    const outputs = new Map();

    for (const rel of jsFiles) {
        const source = fs.readFileSync(path.join(projectDir, 'js', rel), 'utf8');
        outputs.set(`js/${rel}`, transpile(source, `js/${rel}`));
    }
    for (const rel of HTML_PAGES) {
        const source = fs.readFileSync(path.join(projectDir, rel), 'utf8');
        outputs.set(rel, transpileHtml(source, rel));
    }

    const polyfills = await buildPolyfills();
    outputs.set('js/plugin.js', `${polyfills}\n${outputs.get('js/plugin.js')}`);
    // Not embedded: lets the frontend tests run the ES5 modules with the same
    // polyfill layer that plugin.js carries (tests/frontend, JE_ES5_DIR).
    outputs.set('compat-prelude.js', polyfills);

    fs.rmSync(outDir, { recursive: true, force: true });
    // Non-script files next to the scripts (json, fonts) so the output tree is a
    // drop-in js/ directory for the tests; only *.js is embedded from here.
    for (const rel of walk(path.join(projectDir, 'js')).filter((f) => !f.endsWith('.js'))) {
        const target = path.join(outDir, 'js', rel);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(path.join(projectDir, 'js', rel), target);
    }
    // Plain files for the tests (tests/frontend with JE_ES5_DIR, tests/es5), and
    // Brotli-compressed copies under embed/ that the .csproj embeds: the DLL then
    // grows by the compressed size only, and the server decompresses on serving.
    let bytes = 0;
    let compressedBytes = 0;
    for (const [rel, code] of outputs) {
        const target = path.join(outDir, rel);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, code);
        bytes += Buffer.byteLength(code);
        if (rel === 'compat-prelude.js') continue;
        const compressed = zlib.brotliCompressSync(Buffer.from(code), {
            params: {
                [zlib.constants.BROTLI_PARAM_QUALITY]: zlib.constants.BROTLI_MAX_QUALITY,
                [zlib.constants.BROTLI_PARAM_SIZE_HINT]: Buffer.byteLength(code),
            },
        });
        const embedTarget = path.join(outDir, 'embed', `${rel}.br`);
        fs.mkdirSync(path.dirname(embedTarget), { recursive: true });
        fs.writeFileSync(embedTarget, compressed);
        compressedBytes += compressed.length;
    }

    const mb = (n) => `${(n / 1024 / 1024).toFixed(2)} MB`;
    console.log(`ES5 build (${TARGETS}): ${jsFiles.length} scripts, ${HTML_PAGES.length} pages, `
        + `${coreJsUsed.size} core-js modules, ${helpersUsed.size} helpers, `
        + `${mb(bytes)} (${mb(compressedBytes)} embedded, Brotli) -> ${path.relative(repoRoot, outDir)} in ${Date.now() - started} ms`);
}

main().catch((error) => {
    console.error(`ES5 build failed: ${error.message}`);
    process.exit(1);
});
