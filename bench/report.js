#!/usr/bin/env node
'use strict';

/**
 * Aggregate every B1 result directory into one report.json.
 *
 *   node bench/report.js [--results bench/results] [--out bench/results/report.json]
 *
 * Unit of analysis is the SITE-PAGE: one site's 20 runs are correlated, so
 * confidence intervals come from a seeded bootstrap over site-pages, never over runs.
 */
const fs = require('node:fs');
const path = require('node:path');
const CFG = require('../src/config.js');

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, v, i, all) => (v.startsWith('--') ? [...acc, [v.slice(2), all[i + 1]]] : acc), []),
);
const RESULTS = path.resolve(args.results || path.join(__dirname, 'results'));
const OUT = path.resolve(args.out || path.join(RESULTS, 'report.json'));
const THRESHOLDS = [0.9, 0.95, 0.98];
const MAIN = 0.95;
const BOOT = 2000;

const readJson = (f) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null);
const mean = (xs) => {
  const v = xs.filter((x) => typeof x === 'number' && Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};
const round = (x, d = 3) => (x === null ? null : Math.round(x * 10 ** d) / 10 ** d);

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

/** 95% percentile bootstrap CI of the mean. */
function bootstrap(values, seed = 7) {
  const v = values.filter((x) => typeof x === 'number');
  if (v.length < 2) return [null, null];
  const rand = rng(seed);
  const means = [];
  for (let b = 0; b < BOOT; b += 1) {
    let s = 0;
    for (let i = 0; i < v.length; i += 1) s += v[Math.floor(rand() * v.length)];
    means.push(s / v.length);
  }
  means.sort((x, y) => x - y);
  return [round(means[Math.floor(BOOT * 0.025)]), round(means[Math.floor(BOOT * 0.975)])];
}

// readable === null means every sampled text sits on an image/gradient: contrast is
// unknown, not failed (audit showed counting it as a failure produced false alarms).
const passes = (run, t) =>
  run.fgToken !== null && run.fgToken >= t && (run.readable === null || run.readable >= t) && run.exceptions.length === 0;

// --- load & normalise ------------------------------------------------------------

/** Legacy head file (bench/results/raw.json) stored runs at the top level. */
function normalise(rec, stratum) {
  if (rec.pages) return { ...rec, stratum: rec.stratum || stratum };
  const page = rec.status === 'ok' ? { page: 'home', status: 'ok', url: rec.url, n: rec.n, baseline: rec.baseline, runs: rec.runs } : null;
  return { domain: rec.domain, stratum, url: rec.url, cms: rec.cms || 'unknown', status: rec.status, pages: page ? [page] : [] };
}

const sources = [
  { stratum: 'head', file: path.join(RESULTS, 'raw.json') },
  { stratum: 'head', file: path.join(RESULTS, 'head-inner', 'raw.json') },
  { stratum: 'head', file: path.join(RESULTS, 'head-retry', 'raw.json') },
  { stratum: 'tail', file: path.join(RESULTS, 'tail-retry', 'raw.json') },
  { stratum: 'tw', file: path.join(RESULTS, 'tw-retry', 'raw.json') },
  { stratum: 'head', file: path.join(RESULTS, 'head-retry2', 'raw.json') },
  { stratum: 'tail', file: path.join(RESULTS, 'tail-retry2', 'raw.json') },
  { stratum: 'tw', file: path.join(RESULTS, 'tw-retry2', 'raw.json') },
  { stratum: 'tail', file: path.join(RESULTS, 'tail', 'raw.json') },
  { stratum: 'tw', file: path.join(RESULTS, 'tw', 'raw.json') },
];
const sites = [];
const funnel = {};
sources.forEach(({ stratum, file }) => {
  const raw = readJson(file);
  if (!raw) return;
  const key = `${stratum}/${path.basename(path.dirname(file)) === 'results' ? 'home' : path.basename(path.dirname(file))}`;
  funnel[key] = raw.reduce((acc, r) => ({ ...acc, [r.status]: (acc[r.status] || 0) + 1 }), {});
  raw.forEach((r) => sites.push(normalise(r, stratum)));
});

// Flatten to site-pages that were measured.
const sitePages = [];
sites.forEach((s) =>
  (s.pages || [])
    .filter((p) => p.status === 'ok')
    .forEach((p) => sitePages.push({ domain: s.domain, stratum: s.stratum, cms: s.cms || 'unknown', ...p })),
);

// --- per-group statistics --------------------------------------------------------

function groupStats(group) {
  const runsOf = (sp, mode) => sp.runs.filter((r) => r.mode === mode);
  const score = (sp, mode, t) => {
    const rs = runsOf(sp, mode);
    return rs.length ? rs.filter((r) => passes(r, t)).length / rs.length : null;
  };
  const out = { n: group.length };
  ['A', 'B'].forEach((mode) => {
    const scores = group.map((sp) => score(sp, mode, MAIN));
    out[`mode${mode}`] = {
      coverage: round(mean(scores)),
      ci95: bootstrap(scores),
      sitesPassingAllThemes: round(mean(group.map((sp) => (runsOf(sp, mode).every((r) => passes(r, MAIN)) ? 1 : 0)))),
      sensitivity: Object.fromEntries(THRESHOLDS.map((t) => [t, round(mean(group.map((sp) => score(sp, mode, t))))])),
      fgToken: round(mean(group.map((sp) => mean(runsOf(sp, mode).map((r) => r.fgToken))))),
      bgToken: round(mean(group.map((sp) => mean(runsOf(sp, mode).map((r) => r.bgToken))))),
      readable: round(mean(group.map((sp) => mean(runsOf(sp, mode).map((r) => r.readable))))),
      shifted: round(mean(group.map((sp) => mean(runsOf(sp, mode).map((r) => r.shifted))))),
      // Only runs measured after the icon probe existed carry iconVisible.
      iconVisible: round(mean(group.map((sp) => mean(runsOf(sp, mode).map((r) => r.iconVisible))))),
    };
  });
  out.baseline = {
    readable: round(mean(group.map((sp) => sp.baseline?.readable))),
    noiseShift: round(mean(group.map((sp) => sp.baseline?.noiseShift))),
    iconVisible: round(mean(group.map((sp) => sp.baseline?.iconVisible))),
  };
  out.exceptions = group.reduce((n, sp) => n + sp.runs.reduce((m, r) => m + r.exceptions.length, 0), 0);
  // C1 signal: share of site-pages where token colour fails to win on >5% of text in Mode A.
  out.c1 = {
    sitePagesWithCascadeLoss: round(mean(group.map((sp) => (mean(runsOf(sp, 'A').map((r) => r.fgToken)) < MAIN ? 1 : 0)))),
    inlineImportantMisses: group.reduce((n, sp) => n + runsOf(sp, 'A').reduce((m, r) => m + (r.inlineImportant || 0), 0), 0),
  };
  return out;
}

const by = (keyFn) => {
  const m = {};
  sitePages.forEach((sp) => (m[keyFn(sp)] = m[keyFn(sp)] || []).push(sp));
  return Object.fromEntries(Object.entries(m).map(([k, g]) => [k, groupStats(g)]));
};

const perTheme = {};
sitePages.forEach((sp) =>
  sp.runs.forEach((r) => {
    const k = `${r.theme}/${r.mode}`;
    (perTheme[k] = perTheme[k] || []).push(passes(r, MAIN) ? 1 : 0);
  }),
);

const worst = sitePages
  .map((sp) => ({
    domain: sp.domain,
    stratum: sp.stratum,
    page: sp.page,
    passA: sp.runs.filter((r) => r.mode === 'A' && passes(r, MAIN)).length,
    fgToken: round(mean(sp.runs.filter((r) => r.mode === 'A').map((r) => r.fgToken))),
    readable: round(mean(sp.runs.filter((r) => r.mode === 'A').map((r) => r.readable))),
    misses: sp.runs.find((r) => r.mode === 'A' && r.misses.length)?.misses || [],
  }))
  .sort((a, b) => a.passA - b.passA)
  .slice(0, 20);

// --- human audit agreement ---------------------------------------------------------

function kappa(a, b) {
  const keys = Object.keys(a).filter((k) => ['ok', 'broken'].includes(a[k]) && ['ok', 'broken'].includes(b[k]));
  if (!keys.length) return { n: 0 };
  const n = keys.length;
  const agree = keys.filter((k) => a[k] === b[k]).length / n;
  const pa = keys.filter((k) => a[k] === 'broken').length / n;
  const pb = keys.filter((k) => b[k] === 'broken').length / n;
  const pe = pa * pb + (1 - pa) * (1 - pb);
  return { n, agreement: round(agree), cohensKappa: pe === 1 ? null : round((agree - pe) / (1 - pe)) };
}

function audit() {
  const dir = path.join(RESULTS, 'audit');
  const raw = readJson(path.join(dir, 'raw.json'));
  const labels = readJson(path.join(dir, 'labels.json'));
  if (!raw || !labels) return null;
  // Second rater (bench/audit-server.js --rater <name>) → labels-<name>.json
  const others = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^labels-[a-z0-9_-]+\.json$/i.test(f)) : [];
  const interRater = Object.fromEntries(others.map((f) => [f.slice(7, -5), kappa(labels, readJson(path.join(dir, f)))]));
  const pairs = [];
  raw
    .filter((r) => r.status === 'ok')
    .forEach((r) =>
      r.pages.forEach((p) =>
        (p.runs || [])
          .filter((run) => run.shot)
          .forEach((run) => {
            const human = labels[`${r.domain}|${p.page}|${run.theme}|${run.mode}`];
            if (human === 'ok' || human === 'broken') pairs.push({ human, metric: passes(run, MAIN) ? 'ok' : 'broken', theme: `${run.theme}/${run.mode}`, domain: r.domain });
          }),
      ),
    );
  if (!pairs.length) return { labelled: 0 };
  const cell = (h, m) => pairs.filter((x) => x.human === h && x.metric === m).length;
  const tp = cell('broken', 'broken');
  const tn = cell('ok', 'ok');
  const fp = cell('ok', 'broken');
  const fn = cell('broken', 'ok');
  const n = pairs.length;
  const po = (tp + tn) / n;
  const pe = ((tp + fp) * (tp + fn) + (tn + fn) * (tn + fp)) / (n * n);
  return {
    labelled: n,
    unsure: Object.values(labels).filter((v) => v === 'unsure').length,
    confusion: { humanBroken_metricBroken: tp, humanOk_metricOk: tn, humanOk_metricBroken: fp, humanBroken_metricOk: fn },
    agreement: round(po),
    cohensKappa: pe === 1 ? null : round((po - pe) / (1 - pe)),
    metricMissedBreakage: pairs.filter((x) => x.human === 'broken' && x.metric === 'ok').map((x) => `${x.domain} ${x.theme}`),
    interRater,
  };
}

const report = {
  generatedAt: new Date().toISOString(),
  definitions: {
    unit: 'site-page (one site home or inner page)',
    pass: `fgToken ≥ t AND (readable ≥ t OR readable unknown) AND no extension exceptions; main t = ${MAIN}`,
    coverage: 'mean over site-pages of the share of 10 themes that pass',
    ci95: `percentile bootstrap over site-pages, ${BOOT} resamples, seeded`,
  },
  funnel,
  overall: groupStats(sitePages),
  byStratum: by((sp) => sp.stratum),
  byStratumPage: by((sp) => `${sp.stratum}/${sp.page}`),
  byCms: by((sp) => sp.cms),
  perThemeMode: Object.fromEntries(Object.entries(perTheme).map(([k, v]) => [k, { n: v.length, pass: round(mean(v)) }])),
  worst,
  audit: audit(),
  themes: CFG.THEMES.map((t) => t.id),
};
fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ overall: report.overall.modeA, byStratum: Object.fromEntries(Object.entries(report.byStratum).map(([k, v]) => [k, { n: v.n, A: v.modeA.coverage, ci: v.modeA.ci95 }])), audit: report.audit && { n: report.audit.labelled, agreement: report.audit.agreement, kappa: report.audit.cohensKappa } }, null, 2));
