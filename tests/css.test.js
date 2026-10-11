'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const CFG = require('../src/config.js');
const CORE = require('../src/core.js');
const { read, parseCss, themeTokens } = require('./helpers.js');

const css = read('styles/app.css');
const { rules, clean } = parseCss(css);
const tokens = themeTokens(rules, CFG.ATTR.theme);
const themeIds = CFG.THEMES.map((t) => t.id);

test('app.css is inert until a theme attribute is set', () => {
  const gate = `html[${CFG.ATTR.theme}`;
  const leaks = rules.flatMap((r) => r.selectors).filter((s) => !s.startsWith(gate));
  assert.deepEqual(leaks, []);
});

test('app.css uses no at-rules, imports or remote URLs', () => {
  assert.doesNotMatch(clean, /@import|@font-face|url\(/i);
  assert.doesNotMatch(clean, /^\s*@/m);
});

test('attribute names in app.css match config', () => {
  Object.values(CFG.ATTR).forEach((attr) => assert.match(clean, new RegExp(`\\[${attr}`)));
  const used = new Set([...clean.matchAll(/\[(data-uix-[a-z-]+)/g)].map((m) => m[1]));
  assert.deepEqual([...used].sort(), Object.values(CFG.ATTR).sort());
});

test('theme blocks and config registry are the same set', () => {
  assert.deepEqual(Object.keys(tokens).sort(), [...themeIds].sort());
});

for (const id of themeIds) {
  test(`theme "${id}" declares every required token`, () => {
    const missing = CFG.REQUIRED_TOKENS.filter((t) => !(t in (tokens[id] || {})));
    assert.deepEqual(missing, []);
  });

  test(`theme "${id}" meets WCAG contrast`, () => {
    const t = tokens[id];
    const pairs = [
      ['--uix-fg', '--uix-bg'],
      ['--uix-fg', '--uix-surface'],
      ['--uix-muted', '--uix-bg'],
      ['--uix-link', '--uix-bg'],
      ['--uix-link', '--uix-surface'],
      ['--uix-accent-fg', '--uix-accent'],
      ['--uix-brand-fg', '--uix-brand-bg'],
    ];
    pairs.forEach(([a, b]) => {
      assert.ok(CORE.isHexColor(t[a]) && CORE.isHexColor(t[b]), `${a}/${b} must be #rrggbb`);
      const ratio = CORE.contrastRatio(t[a], t[b]);
      assert.ok(ratio >= CFG.MIN_CONTRAST, `${id}: ${a} on ${b} = ${ratio.toFixed(2)}`);
    });
  });

  test(`theme "${id}" brand surface keeps white icons visible`, () => {
    const ratio = CORE.contrastRatio('#ffffff', tokens[id]['--uix-brand-bg']);
    assert.ok(ratio >= CFG.MIN_NON_TEXT_CONTRAST, `${id}: white on --uix-brand-bg = ${ratio.toFixed(2)}`);
  });

  test(`theme "${id}" scheme is light or dark`, () => {
    assert.match(tokens[id]['--uix-scheme'], /^(light|dark)$/);
  });
}

test('components read tokens, not raw colours', () => {
  const tokenBlock = new RegExp(`^html\\[${CFG.ATTR.theme}(="[a-z0-9-]+")?\\]$`);
  const offenders = rules
    .filter((r) => !(r.selectors.length === 1 && tokenBlock.test(r.selectors[0])))
    .flatMap((r) => Object.entries(r.decls))
    .filter(([k, v]) => !k.startsWith('--') && /#[0-9a-f]{3,8}\b|rgba?\(/i.test(v));
  assert.deepEqual(offenders, []);
});

test('Mode A rules never change layout properties (fonts need their own opt-in)', () => {
  const layoutProps = /^(padding|margin|width|height|line-height|border-width|border-radius|display|position|font-size|font-family)/;
  const gates = [`[${CFG.ATTR.enhanced}]`, `[${CFG.ATTR.fonts}]`];
  const offenders = rules
    .filter((r) => r.selectors.some((s) => !gates.some((g) => s.includes(g))))
    .flatMap((r) => Object.keys(r.decls).map((k) => [r.selectors[0], k]))
    .filter(([, k]) => layoutProps.test(k));
  assert.deepEqual(offenders, []);
});
