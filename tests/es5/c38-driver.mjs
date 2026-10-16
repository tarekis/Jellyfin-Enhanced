// Drives jellyfin-web login and collects Jellyfin Enhanced state, in Chromium 38 (old DevTools protocol) or modern Chromium (Playwright).
// stdin JSON: { mode: 'c38'|'modern', url, user, password, timeout }  stdout: JSON result.
// Env: JE_CHROME38, JE_CHROME38_LIBS (c38); JE_CHROMIUM_PATH (modern, optional).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

let input = '';
for await (const chunk of process.stdin) input += chunk;
const cfg = JSON.parse(input);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const timeout = cfg.timeout || 40000;

// ES5-only page code. Runs in the page.
const INSTALL = `(function(){ if (window.__jeHooked) return; window.__jeHooked = true; window.__errors = []; window.__consoleErrors = [];
  window.addEventListener('error', function(e){ if (e.message === undefined) return; window.__errors.push({message: String(e.message), url: e.filename, line: e.lineno, col: e.colno}); }, true);
  var o = console.error; console.error = function(){ var p=[]; for (var i=0;i<arguments.length;i++){ var a=arguments[i]; p.push(a && a.stack ? String(a.stack) : String(a)); } window.__consoleErrors.push(p.join(' | ').slice(0,400)); return o.apply(console, arguments); }; })()`;
const FILL = u => `(function(){ var n=document.querySelector('#txtManualName'), p=document.querySelector('#txtManualPassword');
  if(!n||!p) return 'noform'; function set(el,v){ el.value=v; var e=document.createEvent('Event'); e.initEvent('input',true,true); el.dispatchEvent(e); e=document.createEvent('Event'); e.initEvent('change',true,true); el.dispatchEvent(e); }
  set(n, ${JSON.stringify(u.user)}); set(p, ${JSON.stringify(u.password)});
  var f=document.querySelector('.manualLoginForm'); var b=f && f.querySelector('button[type=submit]'); if(!b) return 'nobutton'; b.click(); return 'submitted'; })()`;
const MANUAL = `(function(){ var f=document.querySelector('.manualLoginForm'); if (f && f.offsetParent) return 'form'; var bs=document.querySelectorAll('button'); for (var i=0;i<bs.length;i++){ if (/manual login/i.test(bs[i].textContent)) { bs[i].click(); return 'clicked'; } } return 'none'; })()`;
const STATE = `JSON.stringify({ ua: navigator.userAgent, je: typeof window.JellyfinEnhanced, initialized: window.JellyfinEnhanced ? window.JellyfinEnhanced.initialized : undefined,
  progress: window.__JE_BUNDLE_PROGRESS, total: window.__JE_BUNDLE_TOTAL, hash: location.hash,
  home: !!document.querySelector('.homePage, #indexPage'), header: !!document.querySelector('.skinHeader'), loginForm: (function(){ var n=document.querySelector('#txtManualName'); return !!(n && n.offsetParent); })(),
  scriptTag: (function(){ var s=document.querySelector('script[plugin="Jellyfin Enhanced"]'); return s ? {version: s.getAttribute('version'), src: s.getAttribute('src')} : null; })(),
  errors: window.__errors || [], consoleErrors: window.__consoleErrors || [] })`;
const SCRIPT_HEAD = `(function(){ var x=new XMLHttpRequest(); x.open('GET','../JellyfinEnhanced/script',false); x.send(); return x.responseText.slice(0,60); })()`;

async function runC38() {
  const chrome = process.env.JE_CHROME38, libs = process.env.JE_CHROME38_LIBS || '';
  if (!chrome) throw new Error('JE_CHROME38 is required');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'je-c38-real-'));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const proc = spawn('xvfb-run', ['-a', chrome, '--no-sandbox', `--remote-debugging-port=${port}`, `--user-data-dir=${tmp}`, '--no-first-run', 'about:blank'],
    { env: { ...process.env, LD_LIBRARY_PATH: libs + (process.env.LD_LIBRARY_PATH ? ':' + process.env.LD_LIBRARY_PATH : '') }, stdio: 'ignore', detached: true });
  const cleanup = () => { try { process.kill(-proc.pid, 'SIGKILL'); } catch {} try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} };
  try {
    let target;
    for (let i = 0; i < 100 && !target; i++) {
      await sleep(300);
      try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(t => t.type === 'page' && t.webSocketDebuggerUrl); } catch {}
    }
    if (!target) throw new Error('Chromium 38 did not expose DevTools');
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('websocket error')); });
    let nextId = 1; const pending = new Map(); const consoleMsgs = [];
    ws.onmessage = ev => { const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
      else if (m.method === 'Console.messageAdded') consoleMsgs.push(m.params.message); };
    const call = (method, params = {}) => new Promise(res => { const id = nextId++; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
    const ev = async expr => { const r = await call('Runtime.evaluate', { expression: expr, returnByValue: true }); return r.result && r.result.result ? r.result.result.value : undefined; };
    await call('Console.enable'); await call('Page.enable'); await call('Runtime.enable');
    await call('Page.addScriptToEvaluateOnLoad', { scriptSource: INSTALL });
    await call('Page.navigate', { url: `${cfg.url}/web/index.html` });
    const out = { method: 'login form driven via DOM (#txtManualName/#txtManualPassword)' };
    // reach login form
    let dl = Date.now() + 60000, step;
    while (Date.now() < dl) { await sleep(500); try { step = await ev(MANUAL); } catch {} if (step === 'form') break; }
    out.loginReached = step;
    dl = Date.now() + 15000; let sub;
    while (Date.now() < dl) { sub = await ev(FILL(cfg)); if (sub === 'submitted') break; await sleep(500); }
    out.submit = sub;
    // wait for home
    let st = {}; dl = Date.now() + 60000;
    while (Date.now() < dl) { await sleep(500); try { const v = await ev(STATE); if (v) st = JSON.parse(v); } catch {} if (st.home && !st.loginForm) break; }
    // wait for JE init
    dl = Date.now() + timeout;
    while (Date.now() < dl) { try { const v = await ev(STATE); if (v) st = JSON.parse(v); } catch {} if (st.initialized === true) break; await sleep(500); }
    await sleep(1000);
    try { const v = await ev(STATE); if (v) st = JSON.parse(v); } catch {}
    out.scriptHead = await ev(SCRIPT_HEAD);
    out.state = st;
    out.consoleErrors = consoleMsgs.filter(m => m.level === 'error').map(m => ({ text: String(m.text).slice(0, 300), url: m.url, line: m.line }));
    ws.close();
    return out;
  } finally { cleanup(); }
}

async function runModern() {
  const { chromium } = await import('@playwright/test');
  let exe = process.env.JE_CHROMIUM_PATH;
  if (!exe) { // Playwright's pinned build may be missing; fall back to any installed Chromium under PLAYWRIGHT_BROWSERS_PATH or /opt/pw-browsers
    const base = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
    try { const d = fs.readdirSync(base).filter(n => /^chromium-\d+$/.test(n)).sort().pop(); if (d && fs.existsSync(path.join(base, d, 'chrome-linux/chrome'))) exe = path.join(base, d, 'chrome-linux/chrome'); } catch {}
  }
  let browser;
  try { browser = await chromium.launch({}); } catch { browser = await chromium.launch(exe ? { executablePath: exe } : {}); }
  try {
    const page = await (await browser.newContext({ locale: 'en-US' })).newPage();
    const consoleErrors = [], pageErrors = [];
    page.on('pageerror', e => pageErrors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') consoleErrors.push({ text: m.text().slice(0, 300), url: m.location().url, line: m.location().lineNumber }); });
    await page.goto(`${cfg.url}/web/index.html#!/login.html`, { waitUntil: 'domcontentloaded' });
    const manual = page.getByRole('button', { name: /manual login|sign in manually/i });
    if (await manual.isVisible()) await manual.click();
    await page.getByLabel(/^User(name)?$/i).fill(cfg.user, { timeout: 45000 });
    await page.getByLabel('Password', { exact: true }).fill(cfg.password);
    await page.getByRole('button', { name: 'Sign In', exact: true }).click();
    await page.waitForFunction(() => !!document.querySelector('.homePage, #indexPage'), null, { timeout: 60000 }).catch(() => {});
    await page.waitForFunction(() => window.JellyfinEnhanced && window.JellyfinEnhanced.initialized === true, null, { timeout }).catch(() => {});
    const st = JSON.parse(await page.evaluate(STATE));
    const scriptHead = await page.evaluate(SCRIPT_HEAD);
    return { method: 'Playwright manual login', state: st, scriptHead, consoleErrors, pageErrors };
  } finally { await browser.close(); }
}

try {
  console.log(JSON.stringify(cfg.mode === 'modern' ? await runModern() : await runC38()));
  process.exit(0);
} catch (e) { console.log(JSON.stringify({ driverError: String(e && e.stack || e) })); process.exit(0); }
