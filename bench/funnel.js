#!/usr/bin/env node
'use strict';

/**
 * Exclusion funnel: classify every site that was NOT measured, so exclusions can
 * be defended (not a website) or bounded (a real website we failed to measure).
 *
 *   node bench/funnel.js [--results bench/results] [--out bench/results/funnel.json]
 *
 * Categories
 *   no-site       DNS failure / connection refused / TLS error — nothing to measure
 *   not-html      responds, but not an HTML page (API, CDN object, redirect to file)
 *   scope-limit   HTML but too little text, or no internal link (tool scope, documented)
 *   bot-blocked   real site answering 401/403/429/503 or a challenge page to automation
 *   real-failed   real HTML site that timed out or errored in the benchmark  ← risk
 * Writes retry lists (bench/strata/retry-<stratum>.txt) for bot-blocked, real-failed and
 * scope-limit sites (a block page can look like "too little text"). Retry results in
 * <stratum>-retry/raw.json are merged back, preferring a successful measurement.
 */
const fs = require('node:fs');
const path = require('node:path');

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, v, i, all) => (v.startsWith('--') ? [...acc, [v.slice(2), all[i + 1]]] : acc), []),
);
const RESULTS = path.resolve(args.results || path.join(__dirname, 'results'));
const OUT = path.resolve(args.out || path.join(RESULTS, 'funnel.json'));
const STRATA_DIR = path.join(__dirname, 'strata');
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';

const sources = [
  { stratum: 'head', files: [path.join(RESULTS, 'raw.json'), path.join(RESULTS, 'head-retry', 'raw.json'), path.join(RESULTS, 'head-retry2', 'raw.json')] },
  { stratum: 'tail', files: [path.join(RESULTS, 'tail', 'raw.json'), path.join(RESULTS, 'tail-retry', 'raw.json'), path.join(RESULTS, 'tail-retry2', 'raw.json')] },
  { stratum: 'tw', files: [path.join(RESULTS, 'tw', 'raw.json'), path.join(RESULTS, 'tw-retry', 'raw.json'), path.join(RESULTS, 'tw-retry2', 'raw.json')] },
];
const RETRYABLE = new Set(['bot-blocked', 'real-failed', 'scope-limit']);

/** First pass + retry pass → one record per domain, preferring a successful measurement. */
function merged(files) {
  const byDomain = new Map();
  files.filter((f) => fs.existsSync(f)).forEach((f, pass) =>
    JSON.parse(fs.readFileSync(f, 'utf8')).forEach((r) => {
      const prev = byDomain.get(r.domain);
      if (!prev || (prev.status !== 'ok' && r.status === 'ok')) byDomain.set(r.domain, { ...r, pass });
      else if (prev.status !== 'ok') byDomain.set(r.domain, { ...r, pass, firstStatus: prev.status });
    }),
  );
  return [...byDomain.values()];
}

async function probe(domain) {
  for (const url of [`https://${domain}/`, `https://www.${domain}/`]) {
    try {
      const res = await fetch(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(12000),
        headers: { 'user-agent': UA, accept: 'text/html,*/*' },
      });
      const ct = res.headers.get('content-type') || '';
      const body = ct.includes('html') ? (await res.text()).slice(0, 20000) : '';
      const challenge = /cf-chl|challenge-platform|captcha|are you a robot|access denied|attention required/i.test(body);
      return { status: res.status, ct, challenge, server: res.headers.get('server') || '' };
    } catch (err) {
      const code = err.cause?.code || err.name;
      if (url.includes('://www.')) return { error: code };
    }
  }
  return { error: 'unknown' };
}

function classify(rec, p) {
  if (rec.status === 'too-little-text') return 'scope-limit';
  if (p.error) return 'no-site';
  if ([401, 403, 429, 503].includes(p.status) || p.challenge) return 'bot-blocked';
  if (p.status >= 400) return 'no-site';
  if (!p.ct.includes('html')) return 'not-html';
  return 'real-failed'; // a reachable HTML site the benchmark could not finish
}

async function pool(items, n, fn) {
  const out = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k]);
      }
    }),
  );
  return out;
}

async function main() {
  const report = { generatedAt: new Date().toISOString(), strata: {} };
  for (const { stratum, files } of sources) {
    if (!fs.existsSync(files[0])) continue;
    const raw = merged(files);
    const notOk = raw.filter((r) => r.status !== 'ok');
    const probes = await pool(notOk, 8, (r) => (r.status === 'too-little-text' ? {} : probe(r.domain)));
    const rows = notOk.map((r, i) => ({ domain: r.domain, benchStatus: r.status, probe: probes[i], category: classify(r, probes[i]) }));
    const counts = rows.reduce((acc, r) => ({ ...acc, [r.category]: (acc[r.category] || 0) + 1 }), {});
    const recovered = raw.filter((r) => r.status === 'ok' && r.pass >= 1).length;
    report.strata[stratum] = { tried: raw.length, measured: raw.filter((r) => r.status === 'ok').length, recoveredByRetry: recovered, excluded: counts, rows };
    const retry = rows.filter((r) => RETRYABLE.has(r.category)).map((r) => r.domain);
    fs.writeFileSync(path.join(STRATA_DIR, `retry-${stratum}.txt`), retry.length ? `${retry.join('\n')}\n` : '');
    console.log(stratum, JSON.stringify({ tried: raw.length, measured: report.strata[stratum].measured, recovered, ...counts }));
  }
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
