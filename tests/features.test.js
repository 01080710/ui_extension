'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const CFG = require('../src/config.js');
const CORE = require('../src/core.js');
const EXPORT = require('../src/exporter.js');
const { manifestFor, TARGETS } = require('../scripts/targets.js');
const { ROOT, read, parseCss, themeTokens } = require('./helpers.js');

const opts = { themeIds: CFG.THEMES.map((t) => t.id), defaults: CFG.DEFAULT_SETTINGS, maxHosts: CFG.MAX_EXCLUDED_HOSTS };
const [lightTheme] = CFG.THEMES.map((t) => t.id);

// ------------------------------------------------------------------ D1 i18n

const locales = fs.readdirSync(path.join(ROOT, '_locales'));
const messages = Object.fromEntries(locales.map((l) => [l, JSON.parse(read(`_locales/${l}/messages.json`))]));

test('D1: default locale exists and every locale has the same keys', () => {
  const manifest = JSON.parse(read('manifest.json'));
  assert.ok(locales.includes(manifest.default_locale));
  const keys = Object.keys(messages[manifest.default_locale]).sort();
  locales.forEach((l) => assert.deepEqual(Object.keys(messages[l]).sort(), keys, l));
});

test('D1: every message key referenced in code/config exists', () => {
  const src = read('src/content.js');
  const used = new Set([
    ...[...src.matchAll(/\bt\('([A-Za-z]+)'/g)].map((m) => m[1]),
    ...CFG.THEMES.map((x) => x.msg),
    ...CFG.EXPORT_FORMATS.map((x) => x.msg),
  ]);
  const manifest = read('manifest.json');
  [...manifest.matchAll(/__MSG_([A-Za-z]+)__/g)].forEach((m) => used.add(m[1]));
  locales.forEach((l) => used.forEach((k) => assert.ok(messages[l][k]?.message, `${l}: ${k}`)));
});

test('D1: placeholders are declared where messages use them', () => {
  locales.forEach((l) =>
    Object.entries(messages[l]).forEach(([k, v]) => {
      const names = [...v.message.matchAll(/\$([A-Z_]+)\$/g)].map((m) => m[1].toLowerCase());
      names.forEach((n) => assert.ok(v.placeholders?.[n], `${l}.${k} uses $${n}$`));
    }),
  );
});

// ------------------------------------------------------------------ D2 follow system

test('D2: followSystem switches to darkTheme only when the OS is dark', () => {
  const s = CORE.sanitizeSettings({ theme: lightTheme, followSystem: true, darkTheme: 'dark', excludedHosts: [] }, opts);
  assert.equal(CORE.resolveEffective(s, { prefersDark: false, host: 'a.com' }).theme, lightTheme);
  assert.equal(CORE.resolveEffective(s, { prefersDark: true, host: 'a.com' }).theme, 'dark');
  const off = { ...s, followSystem: false };
  assert.equal(CORE.resolveEffective(off, { prefersDark: true, host: 'a.com' }).theme, lightTheme);
  // "original by day, dark by night"
  const nightOnly = { ...s, theme: null };
  assert.equal(CORE.resolveEffective(nightOnly, { prefersDark: false, host: 'a.com' }).theme, null);
  assert.equal(CORE.resolveEffective(nightOnly, { prefersDark: true, host: 'a.com' }).theme, 'dark');
});

// ------------------------------------------------------------------ C4 site exclusions

test('C4: host normalisation and validation', () => {
  assert.equal(CORE.normalizeHost('WWW.Example.COM.'), 'example.com');
  assert.equal(CORE.normalizeHost('evil.com/path'), null);
  assert.equal(CORE.normalizeHost('a b.com'), null);
  assert.equal(CORE.normalizeHost(42), null);
});

test('C4: subdomains inherit exclusion, lookalikes do not', () => {
  const list = ['figma.com'];
  assert.equal(CORE.isHostExcluded('figma.com', list), true);
  assert.equal(CORE.isHostExcluded('www.figma.com', list), true);
  assert.equal(CORE.isHostExcluded('app.figma.com', list), true);
  assert.equal(CORE.isHostExcluded('notfigma.com', list), false);
  assert.equal(CORE.isHostExcluded('figma.com.evil.io', list), false);
});

test('C4: excluded host renders nothing even with a theme', () => {
  const s = CORE.sanitizeSettings({ theme: lightTheme, excludedHosts: ['site.io'] }, opts);
  assert.equal(CORE.resolveEffective(s, { prefersDark: false, host: 'sub.site.io' }).theme, null);
  assert.equal(CORE.resolveEffective(s, { prefersDark: false, host: 'other.io' }).theme, lightTheme);
});

test('C4: defaults apply only when the list is absent; size is capped', () => {
  assert.deepEqual(CORE.sanitizeSettings({}, opts).excludedHosts, CFG.DEFAULT_SETTINGS.excludedHosts);
  assert.deepEqual(CORE.sanitizeSettings({ excludedHosts: [] }, opts).excludedHosts, []);
  const many = Array.from({ length: CFG.MAX_EXCLUDED_HOSTS + 50 }, (_, i) => `h${i}.com`);
  assert.equal(CORE.sanitizeSettings({ excludedHosts: many }, opts).excludedHosts.length, CFG.MAX_EXCLUDED_HOSTS);
  assert.deepEqual(CORE.sanitizeSettings({ excludedHosts: ['A.com', 'a.com', '<x>'] }, opts).excludedHosts, ['a.com']);
});

test('C4: iframes resolve to the top-level host', () => {
  assert.equal(CORE.pickTopHost('ads.cdn.net', ['https://news.site', 'https://top.site']), 'top.site');
  assert.equal(CORE.pickTopHost('own.site', []), 'own.site');
  assert.equal(CORE.pickTopHost('own.site', undefined), 'own.site');
  assert.equal(CORE.pickTopHost('own.site', ['null']), 'own.site');
});

// ------------------------------------------------------------------ A1 export

const cssTokens = themeTokens(parseCss(read('styles/app.css')).rules, CFG.ATTR.theme);
// Simulate getComputedStyle: resolve var(--uix-stack-*) the way the browser would.
const primitives = parseCss(read('styles/app.css')).rules.find(
  (r) => r.selectors[0] === `html[${CFG.ATTR.theme}]` && r.decls['--uix-stack-sans'],
).decls;
const resolve = (v) => v.replace(/var\((--[a-z-]+)\)/g, (_, n) => primitives[n] || '');

test('A1: TOKEN_MAP covers every required token', () => {
  assert.deepEqual(Object.keys(EXPORT.TOKEN_MAP).sort(), [...CFG.REQUIRED_TOKENS].sort());
});

for (const { id } of CFG.THEMES) {
  test(`A1: "${id}" exports to all formats`, () => {
    const tokens = EXPORT.collectTokens((n) => resolve(cssTokens[id][n] || ''), CFG.REQUIRED_TOKENS);
    assert.equal(Object.keys(tokens).length, CFG.REQUIRED_TOKENS.length);

    const dtcg = JSON.parse(EXPORT.buildExport('dtcg', id, tokens, CFG.EXPORT_FORMATS).body);
    assert.equal(dtcg.color.bg.$type, 'color');
    assert.equal(dtcg.color.bg.$value.hex, tokens['--uix-bg']);
    assert.equal(dtcg.color.bg.$value.colorSpace, 'srgb');
    assert.equal(dtcg.radius.base.$type, 'dimension');
    assert.equal(typeof dtcg.radius.base.$value.value, 'number');
    assert.ok(Array.isArray(dtcg.font.family.$value) && dtcg.font.family.$value.length > 1);
    assert.ok(!dtcg.font.family.$value.some((f) => f.includes('var(')), 'font stacks must be resolved');

    const css = EXPORT.buildExport('css', id, tokens, CFG.EXPORT_FORMATS);
    assert.equal(css.filename, `uix-${id}.css`);
    assert.match(css.body, /:root \{[\s\S]*--color-bg: #[0-9a-f]{6};/);
    assert.doesNotMatch(css.body, /--uix-/, 'export uses extension-neutral names');

    const tw = EXPORT.buildExport('tailwind', id, tokens, CFG.EXPORT_FORMATS).body;
    assert.match(tw, /@import "tailwindcss";/);
    assert.match(tw, /@theme \{[\s\S]*--color-accent: /);
  });
}

test('A1: unsafe values and unknown formats are rejected', () => {
  const evil = EXPORT.collectTokens(() => 'red; } body { display:none', ['--uix-bg']);
  assert.deepEqual(evil, {});
  assert.equal(EXPORT.buildExport('exe', lightTheme, {}, CFG.EXPORT_FORMATS), null);
  assert.equal(EXPORT.buildExport('css', '../../etc', {}, CFG.EXPORT_FORMATS), null);
});

// ------------------------------------------------------------------ D3 targets

test('D3: every target keeps the same content scripts; Firefox gets a gecko id', () => {
  const base = JSON.parse(read('manifest.json'));
  Object.keys(TARGETS).forEach((target) => {
    const m = manifestFor(target, base);
    assert.deepEqual(m.content_scripts, base.content_scripts, target);
    assert.deepEqual(m.permissions, base.permissions, target);
  });
  assert.match(manifestFor('firefox', base).browser_specific_settings.gecko.id, /@/);
  assert.throws(() => manifestFor('safari', base));
});

// ------------------------------------------------------------------ A1 provenance

const goodMeta = {
  mode: 'enhanced',
  fonts: 'on',
  source: 'shop.example.com.tw',
  exportedAt: '2026-10-12T01:40:00.000Z',
  uixVersion: '0.4.0',
};

test('A1: provenance is validated field by field', () => {
  assert.deepEqual(EXPORT.sanitizeMeta({ ...goodMeta, theme: lightTheme }), { ...goodMeta, theme: lightTheme });
  const hostile = EXPORT.sanitizeMeta({
    source: 'evil.com/path?token=secret',
    exportedAt: 'yesterday */ body{display:none} /*',
    uixVersion: '1.0; drop',
    mode: 'turbo',
    fonts: 'yes',
    extra: 'ignored',
  });
  assert.deepEqual(hostile, {});
});

test('A1: every format carries provenance without breaking its syntax', () => {
  const tokens = EXPORT.collectTokens((n) => resolve(cssTokens[lightTheme][n] || ''), CFG.REQUIRED_TOKENS);
  const dtcg = JSON.parse(EXPORT.buildExport('dtcg', lightTheme, tokens, CFG.EXPORT_FORMATS, goodMeta).body);
  assert.deepEqual(dtcg.$extensions['dev.uix.export'], { ...goodMeta, theme: lightTheme });

  ['css', 'tailwind'].forEach((fmt) => {
    const body = EXPORT.buildExport(fmt, lightTheme, tokens, CFG.EXPORT_FORMATS, goodMeta).body;
    assert.match(body, /source: shop\.example\.com\.tw/, fmt);
    assert.match(body, /exported: 2026-10-12T01:40:00\.000Z/, fmt);
    assert.match(body, /uix: 0\.4\.0/, fmt);
    assert.equal(body.split('*/').length, 2, `${fmt}: exactly one comment terminator`);
  });

  const injected = EXPORT.buildExport('css', lightTheme, tokens, CFG.EXPORT_FORMATS, { source: 'x */ :root{}' }).body;
  assert.doesNotMatch(injected, /source:/, 'invalid source is dropped, not escaped');
});

test('A1: export without provenance still works', () => {
  const tokens = EXPORT.collectTokens((n) => resolve(cssTokens[lightTheme][n] || ''), CFG.REQUIRED_TOKENS);
  const dtcg = JSON.parse(EXPORT.buildExport('dtcg', lightTheme, tokens, CFG.EXPORT_FORMATS).body);
  assert.deepEqual(dtcg.$extensions['dev.uix.export'], { theme: lightTheme });
});
