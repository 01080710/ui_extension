#!/usr/bin/env node
'use strict';

/**
 * C1 decision input: WHY does some text keep the site's colour in Mode A?
 *
 *   node bench/cascade.js [--results bench/results] [--n 20] [--out bench/results/cascade.json]
 *
 * Picks n site-pages (seeded) whose Mode A fgToken < 0.95, reloads each with the
 * theme that missed most, marks up to 5 missed text elements, and asks DevTools
 * (CSS.getMatchedStylesForNode) which rule decides their colour, walking up the
 * ancestors because the reset makes most elements inherit. Causes:
 *   site-important   a site rule or inline style sets `color: … !important` on the
 *                    element or the ancestor it inherits from — only a user-origin
 *                    stylesheet (C1) can beat it
 *   not-targeted     the colour comes from an element UIX's selectors exclude
 *   uix-rule         a UIX rule decides the colour but it is not a token the metric knows
 *   unresolved       chain ended without a decision (reported, never silently relabelled)
 */
const fs = require('node:fs');
const path = require('node:path');
const { CFG, launch, attachExtensionWorld, setSettings, waitForTheme } = require('./harness.js');
const { sample } = require('./measure.js');

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, v, i, all) => (v.startsWith('--') ? [...acc, [v.slice(2), all[i + 1]]] : acc), []),
);
const RESULTS = path.resolve(args.results || path.join(__dirname, 'results'));
const N = Number(args.n || 20);
const OUT = path.resolve(args.out || path.join(RESULTS, 'cascade.json'));
const SEED = 20261011;
const MISS_ATTR = 'data-uix-bench-miss';
const CHAIN_ATTR = 'data-uix-bench-chain'; // "k:d" tokens: ancestor d levels above miss k

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function candidates() {
  const files = [];
  const walk = (d) =>
    fs.existsSync(d) &&
    fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
      if (e.isDirectory() && !['audit', 'shots'].includes(e.name)) walk(path.join(d, e.name));
      else if (e.name === 'raw.json') files.push(path.join(d, e.name));
    });
  walk(RESULTS);
  const out = [];
  files.forEach((f) =>
    JSON.parse(fs.readFileSync(f, 'utf8')).forEach((r) => {
      const pages = r.pages || (r.status === 'ok' ? [{ page: 'home', status: 'ok', url: r.url, runs: r.runs }] : []);
      pages
        .filter((p) => p.status === 'ok' && p.url)
        .forEach((p) => {
          const a = p.runs.filter((x) => x.mode === 'A' && typeof x.fgToken === 'number');
          if (!a.length) return;
          const worst = a.reduce((m, x) => (x.fgToken < m.fgToken ? x : m));
          if (worst.fgToken < 0.95) out.push({ domain: r.domain, url: p.url, theme: worst.theme, fgToken: worst.fgToken });
        });
    }),
  );
  const rand = rng(SEED);
  const uniq = [...new Map(out.map((x) => [x.url, x])).values()];
  for (let i = uniq.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [uniq[i], uniq[j]] = [uniq[j], uniq[i]];
  }
  return { pool: uniq.length, picked: uniq.slice(0, N) };
}

/**
 * In page: mark up to 5 sampled text elements whose colour is not a theme token, and
 * tag each one's ancestor chain so DevTools can walk it (DOM.describeNode has no parent).
 */
function markMisses({ attr, chainAttr, tokenNames }) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const rgb = (c) => {
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = '#000';
    ctx.fillStyle = c;
    ctx.fillRect(0, 0, 1, 1);
    return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3);
  };
  const cs = getComputedStyle(document.documentElement);
  const tokens = tokenNames.map((n) => cs.getPropertyValue(n).trim()).filter((v) => v.startsWith('#')).map(rgb);
  const near = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) <= 6;
  let n = 0;
  for (const el of window.__uixBench.els) {
    if (n >= 5) break;
    if (!el.isConnected) continue;
    if (!tokens.some((t) => near(rgb(getComputedStyle(el).color), t))) {
      el.setAttribute(attr, String(n));
      let d = 0;
      for (let a = el; a && a.nodeType === 1; a = a.parentElement, d += 1) {
        const prev = a.getAttribute(chainAttr);
        a.setAttribute(chainAttr, `${prev ? `${prev} ` : ''}${n}:${d}`);
      }
      n += 1;
    }
  }
  return n;
}

async function diagnose(page, world, marked) {
  const cdp = world.cdp;
  const sheets = new Map();
  cdp.on('CSS.styleSheetAdded', ({ header }) => sheets.set(header.styleSheetId, header));
  await cdp.send('DOM.enable');
  await cdp.send('CSS.enable');
  const isUix = (rule) => {
    const h = sheets.get(rule.styleSheetId);
    return rule.origin === 'injected' || (h && (h.origin === 'injected' || String(h.sourceURL).startsWith('chrome-extension://')));
  };
  const colorDecls = (style) => (style?.cssProperties || []).filter((p) => p.name === 'color' && !p.disabled && p.parsedOk !== false);
  const { root } = await cdp.send('DOM.getDocument', { depth: -1 });
  const results = [];
  for (let k = 0; k < marked; k += 1) {
    let cause = 'unresolved';
    let detail = '';
    for (let d = 0; d < 60; d += 1) {
      const { nodeId } = await cdp
        .send('DOM.querySelector', { nodeId: root.nodeId, selector: `[${CHAIN_ATTR}~="${k}:${d}"]` })
        .catch(() => ({ nodeId: 0 }));
      if (!nodeId) break;
      const m = await cdp.send('CSS.getMatchedStylesForNode', { nodeId }).catch(() => null);
      if (!m) break;
      const rules = (m.matchedCSSRules || []).map((x) => x.rule);
      const inlineImp = colorDecls(m.inlineStyle).find((p) => p.important);
      const siteImp = rules.find((r) => !isUix(r) && r.origin === 'regular' && colorDecls(r.style).some((p) => p.important));
      const uixRule = rules.find((r) => isUix(r) && colorDecls(r.style).length);
      const siteColor = colorDecls(m.inlineStyle).length || rules.some((r) => !isUix(r) && r.origin === 'regular' && colorDecls(r.style).length);
      if (inlineImp || siteImp) {
        cause = 'site-important';
        detail = `${inlineImp ? 'inline style' : siteImp.selectorList?.text?.slice(0, 80)} at depth ${d}`;
        break;
      }
      if (uixRule) {
        if (colorDecls(uixRule.style).some((p) => /inherit/.test(p.value))) continue; // keep walking up
        cause = 'uix-rule';
        detail = `${uixRule.selectorList?.text?.slice(0, 80)} at depth ${d}`;
        break;
      }
      if (siteColor) {
        cause = 'not-targeted';
        detail = `site colour on an element UIX does not select, depth ${d}`;
        break;
      }
    }
    results.push({ cause, detail });
  }
  return results;
}

async function main() {
  const { pool, picked } = candidates();
  console.log(`site-pages with Mode A fgToken < 0.95: ${pool}; analysing ${picked.length}`);
  const browser = await launch();
  const out = [];
  for (const c of picked) {
    const page = await browser.context.newPage();
    const world = await attachExtensionWorld(page);
    try {
      await page.goto(c.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForLoadState('load', { timeout: 8000 }).catch(() => {});
      await new Promise((r) => setTimeout(r, 1500));
      const base = { ...CFG.DEFAULT_SETTINGS, excludedHosts: [] };
      await setSettings(world, base);
      await waitForTheme(page, null);
      await page.evaluate(sample, { max: 300, viewports: 3 });
      await setSettings(world, { ...base, theme: c.theme });
      await waitForTheme(page, c.theme);
      await new Promise((r) => setTimeout(r, 700));
      const marked = await page.evaluate(markMisses, { attr: MISS_ATTR, chainAttr: CHAIN_ATTR, tokenNames: CFG.REQUIRED_TOKENS });
      const elements = marked ? await diagnose(page, world, marked) : [];
      out.push({ ...c, marked, elements });
      console.log(`${c.domain.padEnd(28)} ${c.theme.padEnd(10)} misses ${marked} → ${elements.map((e) => e.cause).join(', ')}`);
      await setSettings(world, base);
    } catch (err) {
      out.push({ ...c, error: String(err.message || err).slice(0, 200) });
      console.log(`${c.domain.padEnd(28)} error ${String(err.message).slice(0, 80)}`);
    } finally {
      await page.close().catch(() => {});
    }
  }
  await browser.close();

  const pages = out.filter((x) => x.elements && x.elements.length);
  const majority = (els) => {
    const c = els.reduce((a, e) => ({ ...a, [e.cause]: (a[e.cause] || 0) + 1 }), {});
    return Object.entries(c).sort((a, b) => b[1] - a[1])[0][0];
  };
  const byPage = pages.reduce((a, p) => ({ ...a, [majority(p.elements)]: (a[majority(p.elements)] || 0) + 1 }), {});
  const allEls = pages.flatMap((p) => p.elements);
  const byElement = allEls.reduce((a, e) => ({ ...a, [e.cause]: (a[e.cause] || 0) + 1 }), {});
  const summary = {
    generatedAt: new Date().toISOString(),
    pool,
    analysed: out.length,
    withMisses: pages.length,
    byPage,
    byElement,
    siteImportantShareOfPages: pages.length ? (byPage['site-important'] || 0) / pages.length : null,
    decisionRule: 'do C1 if ≥ 60% of analysed pages are mainly site-important',
    rows: out,
  };
  fs.writeFileSync(OUT, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ pool, analysed: out.length, withMisses: pages.length, byPage, byElement, siteImportantShareOfPages: summary.siteImportantShareOfPages }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
