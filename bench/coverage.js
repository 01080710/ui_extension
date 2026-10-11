#!/usr/bin/env node
'use strict';

/**
 * B1 — real-world coverage benchmark.
 *
 *   node bench/coverage.js (--list <tranco.csv> | --domains <one-per-line.txt>)
 *     [--stratum head] [--sites 100] [--workers 4] [--pages home,inner]
 *     [--screens dark/A,brutalism/B] [--out bench/results/<stratum>] [--resume 1] [--seed 20261011]
 *
 * Per site: load the home page (and optionally one internal page), then in the same document
 *   baseline ×2 (second pass = layout noise of the live page)
 *   10 themes × Mode A / Mode B, switched through chrome.storage like the panel does.
 * Per (site, page, theme, mode) it records:
 *   fgToken   share of sampled text whose colour is a theme token  → cascade wins (C1 signal)
 *   bgToken   share whose effective background is a theme token  → background leaks
 *   readable  share meeting WCAG AA against the effective background
 *   shifted   share of sampled elements that moved > 4px vs baseline
 *   exceptions thrown inside the extension's isolated world
 * Aggregation lives in bench/report.js.
 */
const fs = require('node:fs');
const path = require('node:path');
const dns = require('node:dns').promises;
const { CFG, launch, attachExtensionWorld, setSettings, waitForTheme } = require('./harness.js');
const { sample, probe } = require('./measure.js');

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, v, i, all) => (v.startsWith('--') ? [...acc, [v.slice(2), all[i + 1]]] : acc), []),
);
const STRATUM = args.stratum || 'head';
const TARGET = Number(args.sites || 100);
const WORKERS = Number(args.workers || 4);
const PAGES = (args.pages || 'home').split(',');
const SCREENS = new Set((args.screens || '').split(',').filter(Boolean));
const OUT = path.resolve(args.out || path.join(__dirname, 'results', STRATUM));
const SHOTS = path.join(OUT, 'shots');
const RESUME = Boolean(args.resume);
const SEED = Number(args.seed || 20261011);
const SAMPLE = { max: 300, viewports: 3 };
const SETTLE_MS = 700;
const LOAD_TIMEOUT = 25000;
const PAGE_BUDGET = 90000; // hard cap per measured page; a hung page must not stall a worker
const SITE_TIMEOUT = PAGE_BUDGET * PAGES.length;

function readDomains() {
  if (args.domains) return fs.readFileSync(args.domains, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
  if (args.list) {
    return fs
      .readFileSync(args.list, 'utf8')
      .split('\n')
      .map((l) => l.split(',')[1]?.trim())
      .filter(Boolean);
  }
  console.error('need --list <tranco csv> or --domains <file>');
  process.exit(2);
}

const base = { ...CFG.DEFAULT_SETTINGS, excludedHosts: [] }; // measure everything, exclusions off
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const share = (rows, key) => {
  const vals = rows.filter((r) => r && r[key] !== null && r[key] !== undefined);
  return vals.length ? vals.filter((r) => r[key] === true).length / vals.length : null;
};
const readableShare = (rows) => {
  const vals = rows.filter((r) => r && r.ratio !== null);
  return vals.length ? vals.filter((r) => r.ratio >= r.need).length / vals.length : null;
};
const shiftedShare = (a, b) => {
  let n = 0;
  let moved = 0;
  a.forEach((r, i) => {
    const s = b[i];
    if (!r || !s) return;
    n += 1;
    if (Math.abs(r.x - s.x) > 4 || Math.abs(r.y - s.y) > 4) moved += 1;
  });
  return n ? moved / n : null;
};

/** Deterministic per-domain index so the inner page choice is reproducible. */
function hashIndex(str, n) {
  let h = SEED;
  for (const ch of str) h = Math.imul(h ^ ch.charCodeAt(0), 2654435761) >>> 0;
  return n ? h % n : 0;
}

// --- in-page helpers (serialised into page.evaluate) ---------------------------

function detectCms() {
  const html = document.documentElement.outerHTML.slice(0, 400000);
  const gen = document.querySelector('meta[name="generator" i]')?.content || '';
  if (/wordpress/i.test(gen) || html.includes('/wp-content/') || html.includes('/wp-includes/')) return 'wordpress';
  if (html.includes('cdn.shopify.com') || /shopify/i.test(gen)) return 'shopify';
  if (/wix\.com/i.test(gen) || html.includes('static.wixstatic.com')) return 'wix';
  if (/squarespace/i.test(gen) || html.includes('static1.squarespace.com')) return 'squarespace';
  if (/drupal/i.test(gen)) return 'drupal';
  if (/joomla/i.test(gen)) return 'joomla';
  return 'other';
}

function innerCandidates() {
  const here = location.hostname.replace(/^www\./, '');
  const skip = /login|signin|sign-in|signup|register|account|cart|checkout|logout|privacy|terms|cookie|javascript:|mailto:|tel:/i;
  const scope = document.querySelector('main, [role="main"], article') || document.body;
  const seen = new Set();
  const out = [];
  for (const a of scope.querySelectorAll('a[href]')) {
    let u;
    try {
      u = new URL(a.href, location.href);
    } catch {
      continue;
    }
    const host = u.hostname.replace(/^www\./, '');
    const sameSite = host === here || host.endsWith(`.${here}`) || here.endsWith(`.${host}`);
    if (!/^https?:$/.test(u.protocol) || !sameSite) continue;
    if (u.pathname === '/' || u.pathname === location.pathname || skip.test(u.href)) continue;
    const key = u.origin + u.pathname;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
    if (out.length >= 40) break;
  }
  return out;
}

// --- measurement --------------------------------------------------------------

async function openUrl(page, url) {
  let res = null;
  try {
    res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: LOAD_TIMEOUT });
  } catch (err) {
    // Landing pages that immediately JS-redirect (common on .tw sites: / → /index.aspx)
    // abort the first navigation. That is a working site: wait for where it lands.
    if (!/interrupted by another navigation/i.test(err.message)) throw err;
    await page.waitForLoadState('domcontentloaded', { timeout: LOAD_TIMEOUT });
  }
  if (res) {
    const ct = res.headers()['content-type'] || '';
    if (res.status() >= 400 || !ct.includes('html')) return null;
  } else if (!(await page.evaluate(() => document.contentType || '')).includes('html')) {
    return null;
  }
  await page.waitForLoadState('load', { timeout: 8000 }).catch(() => {});
  await sleep(1500);
  return page.url();
}

async function openSite(page, domain) {
  for (const host of [domain, `www.${domain}`]) {
    // A failed goto leaves Chromium loading its error page, which aborts the next
    // goto ("interrupted by another navigation"). Many .tw sites only resolve on
    // www., so skip hosts without DNS instead of letting the first attempt fail.
    const resolvable = await dns.lookup(host).then(() => true, () => false);
    if (!resolvable) continue;
    const url = `https://${host}/`;
    try {
      await page.goto('about:blank').catch(() => {});
      const landed = await openUrl(page, url);
      if (landed) return landed;
    } catch {
      /* try next */
    }
  }
  return null;
}

const shotName = (domain, pageKind, label) => `${domain}__${pageKind}__${label}.jpg`.replace(/[^a-z0-9._-]/gi, '_');

async function shoot(page, domain, pageKind, label) {
  fs.mkdirSync(SHOTS, { recursive: true });
  const file = shotName(domain, pageKind, label);
  // Same window the metric samples (SAMPLE.viewports screens), not just the first one.
  const vp = page.viewportSize();
  await page.screenshot({
    path: path.join(SHOTS, file),
    type: 'jpeg',
    quality: 55,
    fullPage: true,
    clip: { x: 0, y: 0, width: vp.width, height: vp.height * SAMPLE.viewports },
  });
  return file;
}

/** Measure the document currently loaded in `page`. */
async function measureCurrent(page, world, domain, pageKind) {
  await setSettings(world, base);
  await waitForTheme(page, null);
  const n = await page.evaluate(sample, SAMPLE);
  if (n < 20) return { page: pageKind, url: page.url(), status: 'too-little-text', n };

  const probeArgs = { tokenNames: CFG.REQUIRED_TOKENS, themeAttr: CFG.ATTR.theme };
  const p1 = await page.evaluate(probe, probeArgs);
  const b1 = p1.rows;
  const shots = {};
  if (SCREENS.size) shots.baseline = await shoot(page, domain, pageKind, 'baseline');
  await sleep(SETTLE_MS);
  const b2 = (await page.evaluate(probe, probeArgs)).rows;
  const result = {
    page: pageKind,
    url: page.url(),
    status: 'ok',
    n,
    baseline: { readable: readableShare(b1), noiseShift: shiftedShare(b1, b2), iconVisible: share(p1.icons, 'visible'), icons: p1.icons.length },
    runs: [],
  };

  for (const { id } of CFG.THEMES) {
    for (const enhanced of [false, true]) {
      const mode = enhanced ? 'B' : 'A';
      const before = world.state.exceptions.length;
      await setSettings(world, { ...base, theme: id, enhanced });
      await waitForTheme(page, id, enhanced);
      await sleep(SETTLE_MS);
      const probed = await page.evaluate(probe, probeArgs);
      const rows = probed.rows;
      const brandBars = await page.evaluate((a) => document.querySelectorAll(`[${a}]`).length, CFG.ATTR.brand);
      const run = {
        theme: id,
        mode,
        fgToken: share(rows, 'fgToken'),
        bgToken: share(rows, 'bgToken'),
        readable: readableShare(rows),
        shifted: shiftedShare(b1, rows),
        iconVisible: share(probed.icons, 'visible'),
        brandBars,
        inlineImportant: rows.filter((r) => r && r.inlineImportant && r.fgToken === false).length,
        misses: rows.filter((r) => r && r.desc).slice(0, 5).map((r) => r.desc),
        exceptions: world.state.exceptions.slice(before),
      };
      if (SCREENS.has(`${id}/${mode}`)) {
        await page.evaluate(() => window.scrollTo(0, 0));
        run.shot = await shoot(page, domain, pageKind, `${id}-${mode}`);
      }
      result.runs.push(run);
    }
  }
  if (SCREENS.size) result.shots = shots;
  await setSettings(world, base);
  return result;
}

async function measureSite(context, domain) {
  const page = await context.newPage();
  const world = await attachExtensionWorld(page);
  try {
    const url = await openSite(page, domain);
    if (!url) return { domain, stratum: STRATUM, status: 'unreachable' };
    const cms = await page.evaluate(detectCms).catch(() => 'unknown');
    const candidates = PAGES.includes('inner') ? await page.evaluate(innerCandidates).catch(() => []) : [];
    const pages = [];

    if (PAGES.includes('home')) pages.push(await measureCurrent(page, world, domain, 'home'));
    if (PAGES.includes('inner')) {
      if (!candidates.length) pages.push({ page: 'inner', status: 'no-inner-link' });
      else {
        const target = candidates[hashIndex(domain, candidates.length)];
        const landed = await openUrl(page, target).catch(() => null);
        pages.push(landed ? await measureCurrent(page, world, domain, 'inner') : { page: 'inner', url: target, status: 'unreachable' });
      }
    }
    const status = pages.some((p) => p.status === 'ok') ? 'ok' : pages[0]?.status || 'error';
    return { domain, stratum: STRATUM, url, cms, status, pages };
  } catch (err) {
    return { domain, stratum: STRATUM, status: 'error', error: String(err.message || err).slice(0, 300) };
  } finally {
    await page.close().catch(() => {});
  }
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const rawPath = path.join(OUT, 'raw.json');
  const results = RESUME && fs.existsSync(rawPath) ? JSON.parse(fs.readFileSync(rawPath, 'utf8')) : [];
  const done = new Set(results.map((r) => r.domain));
  const queue = readDomains().filter((d) => !done.has(d));
  let ok = results.filter((r) => r.status === 'ok').length;
  if (RESUME) console.log(`resuming: ${results.length} recorded, ${ok} ok`);
  fs.writeFileSync(
    path.join(OUT, 'run.json'),
    JSON.stringify({ stratum: STRATUM, pages: PAGES, target: TARGET, seed: SEED, screens: [...SCREENS], startedAt: new Date().toISOString() }, null, 2),
  );

  async function worker(w) {
    let browser = await launch();
    while (queue.length && ok < TARGET) {
      const domain = queue.shift();
      const started = Date.now();
      let timer;
      const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve({ domain, stratum: STRATUM, status: 'timeout' }), SITE_TIMEOUT);
      });
      let r = await Promise.race([measureSite(browser.context, domain), timeout]);
      clearTimeout(timer);
      if (r.status === 'timeout' || (r.status === 'error' && /Target closed|crashed|has been closed/i.test(r.error))) {
        await browser.close().catch(() => {});
        browser = await launch();
        r = { ...r, restarted: true };
      }
      if (r.status === 'ok') ok += 1;
      results.push(r);
      const secs = ((Date.now() - started) / 1000).toFixed(0);
      console.log(`[${STRATUM} w${w}] ${String(ok).padStart(3)}/${TARGET} ${r.status.padEnd(15)} ${domain} (${secs}s)`);
      fs.writeFileSync(rawPath, JSON.stringify(results, null, 1));
    }
    await browser.close();
  }

  await Promise.all(Array.from({ length: WORKERS }, (_, i) => worker(i + 1)));
  fs.writeFileSync(rawPath, JSON.stringify(results, null, 1));
  console.log(`done: ${ok} ok of ${results.length} tried`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
