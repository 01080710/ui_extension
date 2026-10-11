#!/usr/bin/env node
'use strict';

/**
 * Human-audit sample: interleaves seeded picks from each stratum so ~20 measured
 * sites span head / tail / tw. Adult-looking domains are excluded from the audit
 * only (a person has to look at the screenshots) — the count is reported.
 *
 *   node bench/audit-sample.js --head bench/results/raw.json --strata bench/strata --out bench/strata/audit.txt
 *     [--enrich bench/results/report-sites.json]
 * --enrich: a JSON list of domains known to have brand bars (dark/colour site chrome);
 * they are tried first in every stratum so the audit sees enough breakage-prone pages.
 */
const fs = require('node:fs');
const path = require('node:path');

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, v, i, all) => (v.startsWith('--') ? [...acc, [v.slice(2), all[i + 1]]] : acc), []),
);
const SEED = Number(args.seed || 20261011);
const ADULT = /porn|xxx|sex|cam|adult|hentai|nsfw|xvideo|xnxx|onlyfans|escort|nude|fetish|chaturbate|highwebmedia|stripchat/i;

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
const shuffle = (xs, rand) => {
  const a = xs.slice();
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
const lines = (f) => fs.readFileSync(f, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);

const headOk = JSON.parse(fs.readFileSync(args.head, 'utf8')).filter((r) => r.status === 'ok').map((r) => r.domain);
const enrich = new Set(args.enrich ? JSON.parse(fs.readFileSync(args.enrich, 'utf8')) : []);
const prioritise = (xs) => [...xs.filter((d) => enrich.has(d)), ...xs.filter((d) => !enrich.has(d))];
const pools = {
  head: prioritise(shuffle(headOk, rng(SEED + 100))),
  tail: prioritise(shuffle(lines(path.join(args.strata, 'tail.txt')), rng(SEED + 101))),
  tw: prioritise(shuffle(lines(path.join(args.strata, 'tw.txt')), rng(SEED + 102))),
};
const excluded = [];
const clean = Object.fromEntries(
  Object.entries(pools).map(([k, xs]) => [
    k,
    xs.filter((d) => {
      if (!ADULT.test(d)) return true;
      excluded.push(d);
      return false;
    }),
  ]),
);
const order = [];
const strataOf = {};
for (let i = 0; i < 60; i += 1) {
  for (const k of ['head', 'tail', 'tw']) {
    const d = clean[k][i];
    if (d && !(d in strataOf)) {
      order.push(d);
      strataOf[d] = k;
    }
  }
}
fs.writeFileSync(args.out, `${order.join('\n')}\n`);
fs.writeFileSync(args.out.replace(/\.txt$/, '.strata.json'), JSON.stringify({ seed: SEED, strataOf, excludedAdult: excluded.length, enriched: [...enrich].filter((d) => d in strataOf) }, null, 2));
console.log(`audit candidates: ${order.length}, adult-excluded: ${excluded.length}`);
