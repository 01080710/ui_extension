#!/usr/bin/env node
'use strict';

// Usage: node scripts/build.js [chrome|edge|firefox ...]   → dist/<target>/
const fs = require('node:fs');
const path = require('node:path');
const { FILES, TARGETS, manifestFor } = require('./targets.js');

const ROOT = path.resolve(__dirname, '..');

function build(targets = Object.keys(TARGETS)) {
  const base = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  return targets.map((target) => {
    const out = path.join(ROOT, 'dist', target);
    fs.rmSync(out, { recursive: true, force: true });
    FILES.forEach((f) => fs.cpSync(path.join(ROOT, f), path.join(out, f), { recursive: true }));
    fs.writeFileSync(path.join(out, 'manifest.json'), `${JSON.stringify(manifestFor(target, base), null, 2)}\n`);
    return out;
  });
}

if (require.main === module) {
  const args = process.argv.slice(2);
  build(args.length ? args : undefined).forEach((out) => console.log(`built ${path.relative(ROOT, out)}`));
}

module.exports = { build };
