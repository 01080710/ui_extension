'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const CFG = require('../src/config.js');
const { ROOT, read } = require('./helpers.js');

const manifest = JSON.parse(read('manifest.json'));
const contentScripts = [
  'src/config.js', 'src/core.js', 'src/exporter.js', 'src/shadow-style.js',
  'src/pack-core.js', 'src/pack-capture.js', 'src/pack-ui.js', 'src/content.js',
];
const sources = [...contentScripts, 'src/background.js'];

test('l1: no popup anywhere', () => {
  assert.equal(manifest.action?.default_popup, undefined);
  assert.equal(manifest.browser_action, undefined);
  const files = fs
    .readdirSync(ROOT, { recursive: true })
    .map(String)
    .filter((f) => !/(^|[\\/])(node_modules|dist|\.git)([\\/]|$)/.test(f)); // server/node_modules too
  assert.deepEqual(files.filter((f) => /popup\.(html|js)$/i.test(path.basename(f))), []);
});

test('manifest: least privilege', () => {
  assert.equal(manifest.manifest_version, 3);
  // scripting is only for C1 (user-origin CSS); hosts are exactly the content-script hosts,
  // so the reachable surface is unchanged — only the install prompt wording changes.
  assert.deepEqual(manifest.permissions, ['storage', 'scripting']);
  assert.deepEqual(manifest.host_permissions, manifest.content_scripts[0].matches);
  assert.equal(manifest.optional_permissions, undefined);
  assert.equal(manifest.web_accessible_resources, undefined, 'would let pages fingerprint the extension');
  assert.equal(manifest.externally_connectable, undefined);
  // The worker exists only to relay chrome.commands; it adds no permission.
  assert.deepEqual(manifest.background, { service_worker: 'src/background.js' });
  assert.equal(manifest.content_security_policy, undefined, 'keep the MV3 default CSP');
});

test('manifest: commands match config', () => {
  assert.deepEqual(Object.keys(manifest.commands), Object.values(CFG.COMMANDS));
});

test('manifest: content scripts load config → core → content and exist on disk', () => {
  const [cs] = manifest.content_scripts;
  assert.deepEqual(cs.js, contentScripts);
  [...cs.js, ...cs.css].forEach((f) => assert.ok(fs.existsSync(path.join(ROOT, f)), f));
  cs.matches.forEach((m) => assert.match(m, /^https?:\/\//));
});

test('no HTML-string sinks, eval or remote code in scripts', () => {
  // The one URL allowed is the loopback pack server (http://127.0.0.1:<port>).
  const sinks =
    /\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML|document\.write|\beval\s*\(|new Function\s*\(|setTimeout\(\s*['"`]|setInterval\(\s*['"`]|https?:\/\/(?!127\.0\.0\.1:\d+['/])/;
  sources.forEach((f) => assert.doesNotMatch(read(f), sinks, f));
});

test('pack: the server URL is loopback only', () => {
  const u = new URL(CFG.PACK.server);
  assert.equal(u.protocol, 'http:');
  assert.equal(u.hostname, '127.0.0.1');
  assert.equal(u.pathname, '/');
  const auditPort = /args\.port \|\| (\d+)/.exec(read('bench/audit-server.js'))[1];
  assert.notEqual(u.port, auditPort, 'pack server and audit server must be able to run together');
});

test('pack: only the background worker touches the network', () => {
  contentScripts.forEach((f) => assert.doesNotMatch(read(f), /\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon/, f));
  assert.match(read('src/background.js'), /fetch\(`\$\{PACK\.server\}\$\{path\}`/);
});

test('pack: no API key handling in the extension', () => {
  sources.forEach((f) => assert.doesNotMatch(read(f), /ANTHROPIC|x-api-key|sk-ant-/i, f));
});

test('importScripts only loads bundled files', () => {
  sources.forEach((f) =>
    [...read(f).matchAll(/importScripts\(([^)]*)\)/g)].forEach((m) => assert.match(m[1], /^'\/src\/[a-z-]+\.js'$/, f)),
  );
});

test('runtime messages are accepted only from this extension', () => {
  sources
    .filter((f) => /onMessage\.addListener/.test(read(f)))
    .forEach((f) => assert.match(read(f), /sender\.id !== chrome\.runtime\.id/, f));
  assert.ok(sources.filter((f) => /onMessage\.addListener/.test(read(f))).includes('src/pack-ui.js'));
});

test('C1 injects only bundled CSS, into the requesting frame only', () => {
  const bg = read('src/background.js');
  assert.match(bg, /frameIds: \[sender\.frameId\]/);
  assert.match(bg, /files: CFG\.USER_CSS_FILES/);
  CFG.USER_CSS_FILES.forEach((f) => assert.ok(fs.existsSync(path.join(ROOT, f)), f));
  assert.doesNotMatch(bg, /executeScript|\bcss:\s/, 'no script injection, no CSS strings');
});

test('shadow-root stylesheet uses tokens only', () => {
  const { css } = require('../src/shadow-style.js');
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b|rgba?\(|url\(|@import/i);
});

test('no postMessage / window message channel the page could spoof', () => {
  sources.forEach((f) => assert.doesNotMatch(read(f), /postMessage|addEventListener\(\s*['"]message['"]/, f));
});

test('panel lives in a closed shadow root', () => {
  assert.match(read('src/content.js'), /attachShadow\(\{\s*mode:\s*'closed'\s*\}\)/);
});

test('content.js reads ids/keys/attributes from config, not literals', () => {
  const src = read('src/content.js');
  Object.values(CFG.ATTR).forEach((a) => assert.ok(!src.includes(`'${a}'`), `literal ${a}`));
  CFG.KEYS.open.concat(CFG.KEYS.close).forEach((k) => assert.ok(!src.includes(`'${k}'`), `literal ${k}`));
  assert.ok(!src.includes(`'${CFG.STORAGE_KEY}'`));
});

test('D1: content scripts have no user-facing CJK literals (all text via chrome.i18n)', () => {
  ['src/content.js', 'src/pack-ui.js', 'src/pack-core.js', 'src/pack-capture.js'].forEach((f) =>
    assert.doesNotMatch(read(f), /[㐀-鿿]/, f),
  );
});

test('pack-ui reads storage keys and message types from config, not literals', () => {
  const src = read('src/pack-ui.js');
  Object.values(CFG.PACK.storage).forEach((k) => assert.ok(!src.includes(`'${k}'`), `literal ${k}`));
  Object.values(CFG.MESSAGE_TYPES).forEach((k) => assert.ok(!src.includes(`'${k}'`), `literal ${k}`));
});
