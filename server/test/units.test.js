'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const CFG = require('../../src/config.js');
const { safePath, checkProject } = require('../lib/project.js');
const { simplifyCapture } = require('../lib/simplify.js');
const { createAssets, isPrivateAddress } = require('../lib/assets.js');
const { loadEnv } = require('../lib/env.js');

const quiet = { warn() {}, error() {}, log() {} };

test('safePath: relative POSIX paths only', () => {
  assert.equal(safePath('src/App.tsx'), 'src/App.tsx');
  assert.equal(safePath('src/@types/x.d.ts'), 'src/@types/x.d.ts');
  ['../x', 'a/../b', '/abs', 'C:/x', 'c:x', 'a\\b', 'a//b', './a', 'a/./b', '', 'a b', '~/x', 'a\0b', 'x'.repeat(201), null, 3].forEach((p) =>
    assert.equal(safePath(p), null, JSON.stringify(p)),
  );
});

test('checkProject: reserved folders and missing entry files are repairable problems', () => {
  const pkg = { path: 'package.json', content: '{"scripts":{"dev":"vite"}}' };
  const html = { path: 'index.html', content: '' };
  assert.equal(checkProject([pkg, html]).ok, true);
  assert.match(checkProject([pkg]).problem, /index\.html/);
  assert.match(checkProject([html]).problem, /package\.json/);
  assert.match(checkProject([pkg, html, { path: 'public/assets/a.png', content: '' }]).problem, /public\/assets/);
  assert.match(checkProject([pkg, html, { path: '.env', content: 'KEY=1' }]).problem, /\.env/);
  assert.match(checkProject([pkg, html, { path: 'Index.html', content: '' }, { path: 'index.HTML', content: '' }]).problem, /twice/);
});

test('simplify: scripts, hidden nodes, tracker images and unsafe styles are removed', () => {
  const capture = {
    page: { title: 'T', host: 'shop.tw', viewport: { w: 1280, h: 1600 } },
    tree: {
      t: 'body',
      s: { color: 'rgb(0, 0, 0)' },
      c: [
        'Hello',
        { t: 'script', c: ['alert(1)'] },
        { t: 'div', s: { display: 'none' }, c: ['hidden'] },
        { t: 'img', src: 'https://www.google-analytics.com/p.gif' },
        { t: 'img', src: 'https://shop.tw/a.png?sid=1', a: { alt: 'A', onclick: 'x()' } },
        { t: 'p', s: { 'background-image': 'url(javascript:alert(1))', color: 'red; } body {' }, c: ['ok'] },
        { t: '<svg onload=x>' },
      ],
    },
    images: ['https://doubleclick.net/x', 'ftp://x/y'],
    fonts: ['Inter', '<script>'],
    theme: { id: 'dark', mode: 'enhanced', css: ':root {\n  --color-bg: #000;\n}', tailwind: '' },
  };
  const out = simplifyCapture(capture, CFG);
  const json = JSON.stringify(out);
  assert.doesNotMatch(json, /alert|hidden|google-analytics|doubleclick|onclick|sid=|<svg|ftp:/);
  const kids = out.tree.c;
  assert.equal(kids[0], 'Hello');
  assert.deepEqual(kids[1], { t: 'img', src: 'https://shop.tw/a.png', a: { alt: 'A' } });
  assert.equal(kids[2].t, 'p');
  assert.equal(kids[2].s, undefined, 'both unsafe styles dropped');
  assert.deepEqual(out.images, ['https://shop.tw/a.png']);
  assert.deepEqual(out.fonts, ['Inter']);
  assert.match(out.theme.css, /\n  --color-bg/, 'token file keeps its lines');
});

test('simplify: garbage in → empty capture out, never a throw', () => {
  [null, 'x', [], { tree: 'x' }, { tree: { t: 1 } }].forEach((raw) => assert.equal(simplifyCapture(raw, CFG).tree, null));
});

test('assets: private and loopback addresses are refused', () => {
  ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '0.0.0.0', '100.64.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1'].forEach(
    (ip) => assert.equal(isPrivateAddress(ip), true, ip),
  );
  ['8.8.8.8', '172.32.0.1', '2606:4700::1111'].forEach((ip) => assert.equal(isPrivateAddress(ip), false, ip));
});

test('assets: only safe, small raster images are bundled', async () => {
  const lookups = { 'cdn.ok': '93.184.216.34', 'internal.corp': '10.0.0.5' };
  const bodies = {
    'https://cdn.ok/a.png': { type: 'image/png', body: 'PNG' },
    'https://cdn.ok/b.svg': { type: 'image/svg+xml', body: '<svg onload=alert(1)>' },
    'https://cdn.ok/big.jpg': { type: 'image/jpeg', body: 'x'.repeat(4 * 1024 * 1024) },
  };
  const fetched = [];
  const assets = createAssets({
    log: quiet,
    lookup: async (h) => (lookups[h] ? [{ address: lookups[h] }] : []),
    fetchImpl: async (url, opts) => {
      fetched.push(url);
      assert.equal(opts.redirect, 'manual');
      const b = bodies[url];
      return new Response(b ? b.body : 'nope', { status: b ? 200 : 404, headers: { 'content-type': b ? b.type : 'text/plain' } });
    },
  });
  const out = await assets.collectImages([...Object.keys(bodies), 'https://internal.corp/x.png', 'file:///etc/passwd']);
  assert.deepEqual(out.map((i) => [i.src, i.path, i.url]), [['https://cdn.ok/a.png', 'public/assets/img-1.png', '/assets/img-1.png']]);
  assert.ok(!fetched.includes('https://internal.corp/x.png'), 'private host never fetched');
});

test('env: every problem is reported at once', () => {
  assert.throws(() => loadEnv({}), (e) => /ANTHROPIC_API_KEY/.test(e.message) && /LOCAL_TOKEN/.test(e.message) && /EXTENSION_ORIGIN/.test(e.message));
  const ok = loadEnv({ ANTHROPIC_API_KEY: 'k', LOCAL_TOKEN: 'x'.repeat(24), EXTENSION_ORIGIN: 'chrome-extension://abcdefghijklmnop' });
  assert.equal(ok.CLAUDE_MODEL, 'claude-sonnet-5-5');
});
