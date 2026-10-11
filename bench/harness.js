'use strict';

/**
 * Shared Playwright plumbing for bench/e2e.js and bench/coverage.js.
 * The extension has no background page, so settings are written through the
 * content script's own isolated world via CDP — exactly the code path the
 * panel's submit uses (chrome.storage.sync.set → storage.onChanged → render).
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawnSync } = require('node:child_process');
const { chromium } = require('playwright');
const CFG = require('../src/config.js');
const { build } = require('../scripts/build.js');

const ROOT = path.resolve(__dirname, '..');
// Headless Chromium advertises "HeadlessChrome", which many CDNs answer with 403.
// Real users run the extension in ordinary Chrome, so measure what they would see.
// Challenge/CAPTCHA pages are still classified as bot-blocked, never bypassed.
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';
// Load the built package, never the repo root (node_modules would be packed in).
const [EXT_DIR] = build(['chrome']);

async function launch() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uix-bench-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium', // new headless; the headless shell cannot load extensions
    headless: true,
    viewport: { width: 1280, height: 800 },
    userAgent: USER_AGENT,
    args: [`--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`],
  });
  return {
    context,
    async close() {
      // A hung renderer can make context.close() wait forever: cap it, then kill by profile dir.
      await Promise.race([context.close().catch(() => {}), new Promise((r) => setTimeout(r, 10000))]);
      spawnSync('pkill', ['-f', userDataDir]);
      fs.rmSync(userDataDir, { recursive: true, force: true });
    },
  };
}

/** Track the extension's isolated world in the page's main frame, plus its exceptions. */
async function attachExtensionWorld(page) {
  const cdp = await page.context().newCDPSession(page);
  const state = { contextId: null, contextIds: new Set(), exceptions: [] };
  const { frameTree } = await cdp.send('Page.getFrameTree');
  const mainFrameId = frameTree.frame.id;
  cdp.on('Runtime.executionContextCreated', ({ context }) => {
    const aux = context.auxData || {};
    if (aux.type === 'isolated' && String(context.origin).startsWith('chrome-extension://')) {
      state.contextIds.add(context.id);
      if (aux.frameId === mainFrameId) state.contextId = context.id;
    }
  });
  cdp.on('Runtime.executionContextsCleared', () => {
    state.contextId = null;
  });
  cdp.on('Runtime.exceptionThrown', ({ exceptionDetails }) => {
    if (state.contextIds.has(exceptionDetails.executionContextId)) {
      state.exceptions.push(exceptionDetails.exception?.description || exceptionDetails.text);
    }
  });
  await cdp.send('Runtime.enable');
  return { cdp, state };
}

async function waitFor(fn, timeoutMs = 10000, stepMs = 100) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return false;
}

async function setSettings(world, settings) {
  const ok = await waitFor(() => world.state.contextId !== null, 10000);
  if (!ok) throw new Error('extension content script not found in page');
  const expression = `chrome.storage.sync.set(${JSON.stringify({ [CFG.STORAGE_KEY]: settings })}).then(() => true)`;
  const res = await world.cdp.send('Runtime.evaluate', {
    expression,
    contextId: world.state.contextId,
    awaitPromise: true,
    returnByValue: true,
  });
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.text);
}

/** Resolves once <html> reflects `theme` (null = off). */
async function waitForTheme(page, theme, enhanced = false, timeoutMs = 8000) {
  await page.waitForFunction(
    ([attr, enhAttr, t, e]) => {
      const r = document.documentElement;
      return r.getAttribute(attr) === t && r.hasAttribute(enhAttr) === e;
    },
    [CFG.ATTR.theme, CFG.ATTR.enhanced, theme, Boolean(theme) && enhanced],
    { timeout: timeoutMs },
  );
}

function serveDir(dir) {
  const server = http.createServer((req, res) => {
    const file = path.join(dir, path.normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(dir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(fs.readFileSync(file));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, origin: `http://127.0.0.1:${server.address().port}` }));
  });
}

module.exports = { ROOT, CFG, launch, attachExtensionWorld, setSettings, waitForTheme, waitFor, serveDir };
