#!/usr/bin/env node
'use strict';

/**
 * Reproducible stratified samples from the Tranco list.
 *
 *   node bench/sample.js --tranco <top-1m.csv> --out bench/strata [--seed 20261011]
 *
 * Writes one domain per line, in the order the benchmark should try them:
 *   tail.txt   uniform random over ranks 10,000 – 1,000,000 (oversampled ×3: many are dead)
 *   tw.txt     uniform random over all .tw domains in the list (oversampled ×3)
 * The head stratum is the list itself in rank order (bench/coverage.js --list).
 */
const fs = require('node:fs');
const path = require('node:path');

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, v, i, all) => (v.startsWith('--') ? [...acc, [v.slice(2), all[i + 1]]] : acc), []),
);
const SEED = Number(args.seed || 20261011);
const OUT = path.resolve(args.out || path.join(__dirname, 'strata'));
const STRATA = {
  tail: { minRank: 10000, maxRank: 1000000, filter: () => true, want: 100 },
  tw: { minRank: 1, maxRank: 1000000, filter: (d) => d.endsWith('.tw'), want: 50 },
};
const OVERSAMPLE = 3;

/** mulberry32 — tiny deterministic PRNG so anyone can regenerate the same sample. */
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

function shuffle(xs, rand) {
  const a = xs.slice();
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const rows = fs
  .readFileSync(args.tranco, 'utf8')
  .split('\n')
  .map((l) => l.split(','))
  .filter((r) => r.length === 2)
  .map(([rank, domain]) => ({ rank: Number(rank), domain: domain.trim() }));

fs.mkdirSync(OUT, { recursive: true });
const meta = { seed: SEED, source: path.basename(args.tranco), listSize: rows.length, strata: {} };
Object.entries(STRATA).forEach(([name, s], i) => {
  const pool = rows.filter((r) => r.rank >= s.minRank && r.rank <= s.maxRank && s.filter(r.domain));
  const picked = shuffle(pool, rng(SEED + i)).slice(0, s.want * OVERSAMPLE);
  fs.writeFileSync(path.join(OUT, `${name}.txt`), `${picked.map((r) => r.domain).join('\n')}\n`);
  meta.strata[name] = { ...s, filter: undefined, poolSize: pool.length, candidates: picked.length };
  console.log(`${name}: pool ${pool.length}, wrote ${picked.length} candidates`);
});
fs.writeFileSync(path.join(OUT, 'meta.json'), JSON.stringify(meta, null, 2));
