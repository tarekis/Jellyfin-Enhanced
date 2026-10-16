// Boots the Jellyfin Enhanced client (plugin.js + component bundle) in a real
// Chromium 38 against a local mock server and reports load errors.
// Usage: JE_CHROME38=<chrome> JE_CHROME38_LIBS=<libdir> node tests/es5/chromium38-smoke.mjs [--src <js root>] [--timeout <ms>] [--seerr]
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const srcDir = path.resolve(opt('--src', path.join(root, 'Jellyfin.Plugin.JellyfinEnhanced/obj/es5/js')));
const timeoutMs = Number(opt('--timeout', 20000));
const seerr = args.includes('--seerr');
const chrome = process.env.JE_CHROME38;
const libs = process.env.JE_CHROME38_LIBS || '';
if (!chrome) { console.error('JE_CHROME38 (chromium 38 binary) is required'); process.exit(2); }
if (!fs.existsSync(path.join(srcDir, 'plugin.js'))) { console.error(`No plugin.js in ${srcDir}`); process.exit(2); }

const VERSION = '1.2.3';
const manifest = JSON.parse(fs.readFileSync(path.join(srcDir, 'component-scripts.json'), 'utf8'));
const scripts = manifest.filter(e => typeof e === 'string' && e.trim() && !e.trim().startsWith('//')).map(e => e.trim());
const bundle = `window.__JE_BUNDLE_TOTAL = ${scripts.length};\nwindow.__JE_BUNDLE_PROGRESS = 0;\nwindow.__JE_BUNDLE_MODULES = [\n` +
  scripts.map(p => `/* ---- js/${p} ---- */\nfunction () {\n${fs.readFileSync(path.join(srcDir, p), 'utf8')}\n},\n`).join('') + '];\n';
const payload = { UserId: 'user-a', Version: VERSION, PublicConfig: seerr ? { JellyseerrEnabled: true } : {}, PrivateConfig: null, HasCustomTabs: false,
  HasPluginPages: false, UserSettings: {}, ComponentScripts: manifest };

const requests = [];
const seerrRequests = [];
const requestBodies = [];
const seerrResults = [
  { id: 101, mediaType: 'movie', title: 'Dune Part Three', releaseDate: '2026-12-18', posterPath: '/p101.jpg', overview: 'Movie without mediaInfo' },
  { id: 202, mediaType: 'tv', name: 'Dune Prophecy', firstAirDate: '2024-11-17', posterPath: '/p202.jpg', overview: 'Show without mediaInfo' },
  { id: 303, mediaType: 'movie', title: 'Dune', releaseDate: '2021-09-15', posterPath: '/p303.jpg', overview: 'Available movie', mediaInfo: { status: 5 } }
];
const send = (res, code, type, body) => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(body); };
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;
  const origin = `http://${req.headers.host}`;
  let status = 200;
  const reply = (code, type, body) => { status = code; send(res, code, type, body); };
  if (p === '/' || p === '/index.html') {
    reply(200, 'text/html', `<!doctype html><html><head><meta charset="utf-8"><title>JE smoke</title>
<script>
window.__errors = [];
window.__errorDetails = [];
(function () {
  var orig = console.error;
  console.error = function () {
    var parts = [];
    for (var i = 0; i < arguments.length; i++) { var a = arguments[i]; parts.push(a && a.stack ? String(a.stack) : (a && a.message ? String(a.message) : String(a))); }
    window.__errorDetails.push(parts.join(' | '));
    return orig.apply(console, arguments);
  };
})();
window.onerror = function (msg, url, line, col) { window.__errors.push({ message: String(msg), url: url, line: line, col: col }); };
// What jellyfin-web keeps for a signed-in user (read by e.g. the pause screen).
try { localStorage.setItem('jellyfin_credentials', JSON.stringify({ Servers: [{ Id: 'server-1', UserId: 'user-a', AccessToken: 'token', ManualAddress: '${origin}' }] })); } catch (e) {}
window.ApiClient = {
  _serverInfo: { Id: 'server-1' },
  accessToken: function () { return 'token'; },
  serverId: function () { return 'server-1'; },
  getCurrentUserId: function () { return 'user-a'; },
  getUrl: function (p) { return '${origin}' + (p.charAt(0) === '/' ? '' : '/') + p; },
  ajax: function (req) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open(req.type || 'GET', req.url, true);
      xhr.onload = function () {
        if (xhr.status < 200 || xhr.status >= 300) { reject(new Error('HTTP ' + xhr.status + ' ' + req.url)); return; }
        if (req.dataType === 'json') { try { resolve(JSON.parse(xhr.responseText)); } catch (e) { reject(e); } }
        else resolve(xhr.responseText);
      };
      xhr.onerror = function () { reject(new Error('Network error ' + req.url)); };
      xhr.send(req.data || null);
    });
  }
};
</script>
${seerr ? `<script>location.hash = '#/search';</script>` : ''}
<script plugin="Jellyfin Enhanced" version="${VERSION}-build123" src="../JellyfinEnhanced/script?v=1" defer></script>
</head><body>${seerr ? `<div id="searchPage" class="page libraryPage"><div class="searchFields"><input id="searchTextInput" type="search" autocomplete="off"></div>
<div class="searchResults padded-top padded-bottom-page"><div class="verticalSection"><h2 class="sectionTitle">Movies</h2><div class="itemsContainer"></div></div></div></div>` : ''}</body></html>`);
  } else if (p === '/JellyfinEnhanced/script') reply(200, 'application/javascript', fs.readFileSync(path.join(srcDir, 'plugin.js')));
  else if (p === '/JellyfinEnhanced/bootstrap') reply(200, 'application/json', JSON.stringify(payload));
  else if (p === '/JellyfinEnhanced/bundle.js') reply(200, 'application/javascript', bundle);
  else if (seerr && req.method === 'POST' && p === '/JellyfinEnhanced/jellyseerr/request') {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      try { requestBodies.push(JSON.parse(body)); } catch { requestBodies.push({ unparsable: body }); }
      reply(201, 'application/json', '{"id":1}');
      requests.push(`${status} POST ${p}`); seerrRequests.push(`POST ${p}`);
    });
    return;
  }
  else if (p === '/JellyfinEnhanced/version') reply(200, 'application/json', JSON.stringify(VERSION));
  else if (p === '/JellyfinEnhanced/public-config') reply(200, 'application/json', '{}');
  else if (p.startsWith('/JellyfinEnhanced/js/') || p.startsWith('/JellyfinEnhanced/locales/')) {
    const rel = p.slice('/JellyfinEnhanced/'.length).replace(/^js\//, '');
    const file = path.join(srcDir, rel);
    if (file.startsWith(srcDir + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      reply(200, file.endsWith('.json') ? 'application/json' : 'application/javascript', fs.readFileSync(file));
    } else reply(404, 'text/plain', 'not found');
  } else if (seerr && p.startsWith('/JellyfinEnhanced/')) {
    if (p === '/JellyfinEnhanced/jellyseerr/status') reply(200, 'application/json', '{"active":true}');
    else if (p === '/JellyfinEnhanced/jellyseerr/user-status') reply(200, 'application/json', JSON.stringify({ active: true, userFound: true, jellyseerrUserId: '1', reason: 'linked', canRequestAdvanced: false }));
    else if (p === '/JellyfinEnhanced/jellyseerr/search') reply(200, 'application/json', JSON.stringify({ page: 1, totalPages: 1, totalResults: 3, results: seerrResults }));
    else reply(200, 'application/json', '{}');
    seerrRequests.push(`${req.method} ${p}`);
  } else reply(404, 'text/plain', 'not found');
  requests.push(`${status} ${p}`);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const serverPort = server.address().port;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'je-c38-'));
const debugPort = 20000 + Math.floor(Math.random() * 20000);
const proc = spawn('xvfb-run', ['-a', chrome, '--no-sandbox', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${tmp}`, '--no-first-run', 'about:blank'],
  { env: { ...process.env, LD_LIBRARY_PATH: libs + (process.env.LD_LIBRARY_PATH ? ':' + process.env.LD_LIBRARY_PATH : '') }, stdio: ['ignore', 'ignore', 'pipe'], detached: true });
let chromeStderr = '';
proc.stderr.on('data', d => { chromeStderr += d; });
const cleanup = () => { try { process.kill(-proc.pid, 'SIGKILL'); } catch {} server.close(); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} };
const fail = msg => { console.error(msg + (chromeStderr ? '\nchrome stderr:\n' + chromeStderr.slice(-2000) : '')); cleanup(); process.exit(2); };

let target;
for (let i = 0; i < 100 && !target; i++) {
  await sleep(300);
  try { const list = await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json(); target = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl); } catch {}
}
if (!target) fail('Chromium 38 did not expose the DevTools endpoint');

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('websocket error')); }).catch(e => fail(e.message));
let nextId = 1; const pending = new Map(); const consoleMsgs = [];
ws.onmessage = ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  else if (m.method === 'Console.messageAdded') consoleMsgs.push(m.params.message);
};
const call = (method, params = {}) => new Promise(res => { const id = nextId++; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const evalJs = async expr => { const r = await call('Runtime.evaluate', { expression: expr, returnByValue: true }); return r.result && r.result.result ? r.result.result.value : undefined; };

await call('Console.enable'); await call('Page.enable'); await call('Runtime.enable');
await call('Page.navigate', { url: `http://127.0.0.1:${serverPort}/` });

const stateExpr = `JSON.stringify({ je: typeof window.JellyfinEnhanced, keys: window.JellyfinEnhanced ? Object.keys(window.JellyfinEnhanced).length : 0,
  initialized: window.JellyfinEnhanced ? window.JellyfinEnhanced.initialized : undefined,
  progress: window.__JE_BUNDLE_PROGRESS, total: window.__JE_BUNDLE_TOTAL, errors: window.__errors || [], errorDetails: window.__errorDetails || [] })`;
const deadline = Date.now() + timeoutMs;
let state = {};
while (Date.now() < deadline) {
  await sleep(500);
  try { const v = await evalJs(stateExpr); if (v) state = JSON.parse(v); } catch {}
  if (state.initialized === true) break;
}
await sleep(1000);
try { const v = await evalJs(stateExpr); if (v) state = JSON.parse(v); } catch {}

const seerrOut = {};
if (seerr) {
  const waitFor = async (expr, ms) => { const end = Date.now() + ms; while (Date.now() < end) { try { const v = await evalJs(expr); if (v) return v; } catch {} await sleep(250); } return null; };
  // Wait for the plugin's Seerr script to attach to the search input.
  const attached = await waitFor(`document.getElementById('searchTextInput') && document.getElementById('searchTextInput').getAttribute('data-jellyseerr-listener') === 'true'`, 10000);
  seerrOut.listenerAttached = !!attached;
  await evalJs(`(function () { var i = document.getElementById('searchTextInput'); i.value = 'dune'; var e = document.createEvent('Event'); e.initEvent('input', true, true); i.dispatchEvent(e); return 1; })()`);
  const cardExpr = `document.querySelectorAll('.jellyseerr-section .jellyseerr-card').length`;
  await waitFor(`${cardExpr} >= 2`, 10000);
  seerrOut.cardCount = await evalJs(cardExpr);
  seerrOut.cardTitles = JSON.parse(await evalJs(`JSON.stringify([].map.call(document.querySelectorAll('.jellyseerr-section .jellyseerr-card'), function (c) { var b = c.querySelector('.cardText-first bdi'); return b ? b.textContent : null; }))`) || '[]');
  // Open the movie 101 overview by clicking its poster (the request button lives in the overview), then click the button.
  seerrOut.posterClicked = await evalJs(`(function () { var cs = document.querySelectorAll('.jellyseerr-section .jellyseerr-card'); for (var i = 0; i < cs.length; i++) { if (cs[i].querySelector('.cardText-first bdi').textContent === 'Dune Part Three') { var p = cs[i].querySelector('.jellyseerr-poster-image'); if (!p) return false; var e = document.createEvent('MouseEvents'); e.initMouseEvent('click', true, true, window, 1, 0, 0, 0, 0, false, false, false, false, 0, null); p.dispatchEvent(e); return true; } } return false; })()`);
  await waitFor(`document.querySelector('.jellyseerr-request-button[data-tmdb-id="101"]')`, 3000);
  seerrOut.buttons = JSON.parse(await evalJs(`JSON.stringify([].map.call(document.querySelectorAll('.jellyseerr-request-button'), function (b) { return { id: b.getAttribute('data-tmdb-id'), type: b.getAttribute('data-media-type'), text: b.textContent.replace(/\\s+/g, ' ').trim(), disabled: b.disabled }; }))`) || '[]');
  // Click the movie 101 request button like a user.
  seerrOut.clicked = await evalJs(`(function () { var b = document.querySelector('.jellyseerr-section .jellyseerr-request-button[data-tmdb-id="101"]'); if (!b) return false; b.click(); return true; })()`);
  { const end = Date.now() + 8000; while (Date.now() < end && requestBodies.length === 0) await sleep(250); }
  await sleep(500);
  seerrOut.buttonAfterClick = await evalJs(`(function () { var b = document.querySelector('.jellyseerr-request-button[data-tmdb-id="101"]'); return b ? b.textContent.replace(/\\s+/g, ' ').trim() : null; })()`);
  // Remote-style Enter on a focused poster (TV show 202), sent as a real trusted key event via the DevTools Input domain.
  seerrOut.enterFocused = await evalJs(`(function () { var cs = document.querySelectorAll('.jellyseerr-section .jellyseerr-card'); for (var i = 0; i < cs.length; i++) { if (cs[i].querySelector('.cardText-first bdi').textContent === 'Dune Prophecy') { var p = cs[i].querySelector('.jellyseerr-poster-image'); p.focus(); return document.activeElement === p; } } return false; })()`);
  const overviewExpr = `!!document.querySelector('.jellyseerr-request-button[data-tmdb-id="202"]')`;
  seerrOut.overviewBeforeEnter = await evalJs(overviewExpr);
  await call('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, keyIdentifier: 'Enter' });
  await call('Input.dispatchKeyEvent', { type: 'char', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' });
  await call('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, keyIdentifier: 'Enter' });
  await sleep(1000);
  seerrOut.overviewAfterEnter = await evalJs(overviewExpr);
  seerrOut.keyboardEventHasKeyProp = await evalJs(`'key' in KeyboardEvent.prototype`);
}

const loc = m => `${m.url || ''}:${m.line || 0}`;
const uncaught = (state.errors || []).map(e => ({ message: e.message, location: `${e.url}:${e.line}:${e.col}` }));
// Syntax errors in script files are reported to the console, not always to window.onerror.
for (const m of consoleMsgs) if (m.level === 'error' && /^Uncaught /.test(m.text) && !uncaught.some(u => m.text.includes(u.message) || u.message.includes(m.text.replace(/^Uncaught /, ''))))
  uncaught.push({ message: m.text, location: loc(m) });
const problems = consoleMsgs.filter(m => m.level === 'error' || m.level === 'warning').map(m => ({ level: m.level, text: m.text, location: loc(m) }));
const progressOk = typeof state.progress === 'number' && state.progress === state.total && state.total > 0;
const summary = { src: srcDir, chrome: (await evalJs('navigator.userAgent')), jellyfinEnhanced: state.je, exportedKeys: state.keys,
  initialized: state.initialized === true, bundleProgress: state.progress, bundleTotal: state.total, uncaughtErrors: uncaught, consoleProblems: problems, consoleErrorDetails: state.errorDetails || [], requests };
if (seerr) Object.assign(summary, { seerr: seerrOut, seerrRequests, requestBodies });
console.log(JSON.stringify(summary, null, 2));
cleanup();
const seerrOk = !seerr || (seerrOut.cardCount >= 2 && requestBodies.some(b => b.mediaType === 'movie' && b.mediaId === 101));
process.exit(uncaught.length === 0 && progressOk && state.initialized === true && seerrOk ? 0 : 1);
