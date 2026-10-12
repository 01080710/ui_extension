'use strict';

// HTTP-level tests: real server on 127.0.0.1, fake Claude, real zip.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const CFG = require('../../src/config.js');
const { createApp } = require('../lib/app.js');
const { ClaudeError } = require('../lib/claude.js');

const SECRET_KEY = 'sk-ant-TEST-SECRET-KEY-must-never-leak';
const env = {
  ANTHROPIC_API_KEY: SECRET_KEY,
  LOCAL_TOKEN: 'local-token-0123456789-abcdef',
  EXTENSION_ORIGIN: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop',
  CLAUDE_MODEL: 'claude-sonnet-5-5',
};
const P = CFG.PACK;
const quiet = { warn() {}, error() {}, log() {} };
const stack = { framework: P.stack.framework[0].id, language: P.stack.language[0].id, styling: P.stack.styling[0].id };
const assets = Object.fromEntries(P.assetKinds.map((k) => [k.id, 'placeholder']));
const capture = { page: { host: 'shop.tw', viewport: { w: 1280, h: 1600 } }, tree: { t: 'body', c: ['Hi'] }, theme: { id: 'dark', css: ':root{}', tailwind: '' } };
const files = [
  { path: 'package.json', content: '{"scripts":{"dev":"vite"}}' },
  { path: 'index.html', content: '<!doctype html>' },
];

let server;
let port;
let nextGenerate;
const bodies = [];

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });

test.before(async () => {
  port = await freePort();
  const cfg = { ...CFG, PACK: { ...P, server: `http://127.0.0.1:${port}` } };
  const claude = {
    analyze: async () => ({ suggested: { stack, assets }, summary: 'ok', questions: [] }),
    generate: async () => nextGenerate(),
  };
  server = createApp({ env, cfg, claude, assets: { collectImages: async () => [] }, log: quiet });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
});

test.after(() => server?.close());

function call(path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: {
          host: `127.0.0.1:${port}`,
          origin: env.EXTENSION_ORIGIN,
          'x-local-token': env.LOCAL_TOKEN,
          'content-type': 'application/json',
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          bodies.push(text, JSON.stringify(res.headers));
          resolve({ status: res.statusCode, headers: res.headers, text });
        });
      },
    );
    req.on('error', reject);
    req.end(data);
  });
}

const events = (text) => text.trim().split('\n').map((l) => JSON.parse(l));
const genBody = { capture, stack, assets, answers: [], summary: '', locale: 'zh-TW' };

test('auth: token, origin and Host are all required', async () => {
  assert.equal((await call('/analyze', { capture }, { 'x-local-token': 'wrong' })).status, 403);
  assert.equal((await call('/analyze', { capture }, { 'x-local-token': '' })).status, 403);
  assert.equal((await call('/analyze', { capture }, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await call('/analyze', { capture }, { origin: 'chrome-extension://otherextensionidxxxxxxxxxxxxxx' })).status, 403);
  assert.equal((await call('/analyze', { capture }, { host: `localhost:${port}` })).status, 403, 'DNS rebinding');
});

test('no CORS headers: a web page could not read any response', async () => {
  const r = await call('/analyze', { capture });
  assert.equal(r.headers['access-control-allow-origin'], undefined);
  assert.equal(r.headers['cache-control'], 'no-store');
});

test('/analyze returns the analysis JSON', async () => {
  const r = await call('/analyze', { capture, locale: 'zh-TW' });
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(r.text).suggested.stack, stack);
});

test('/generate streams phases and a zip', async () => {
  nextGenerate = async () => ({ status: 'ok', files });
  const r = await call('/generate', genBody);
  const ev = events(r.text);
  assert.deepEqual(ev.filter((e) => e.type === 'phase').map((e) => e.phase), ['generate', 'pack']);
  const done = ev.at(-1);
  assert.equal(done.type, 'done');
  assert.equal(done.filename, 'uix-pack-shop-tw-dark.zip');
  const zip = Buffer.from(done.zip, 'base64');
  assert.equal(zip.subarray(0, 2).toString(), 'PK');
  assert.ok(zip.includes(Buffer.from('uix-pack-shop-tw-dark/package.json')));
});

test('/generate forwards need_clarification instead of failing', async () => {
  nextGenerate = async () => ({ status: 'need_clarification', questions: [{ id: 'menu', question: 'Hover?', options: ['a', 'b'], required: true }] });
  const ev = events((await call('/generate', genBody)).text);
  assert.equal(ev.at(-1).type, 'need_clarification');
  assert.equal(ev.at(-1).questions[0].id, 'menu');
});

test('/generate: unsafe path becomes an error event, nothing zipped', async () => {
  nextGenerate = async () => {
    throw new ClaudeError('unsafe-path');
  };
  const ev = events((await call('/generate', genBody)).text);
  assert.deepEqual(ev.at(-1), { type: 'error', code: 'unsafe-path' });
  assert.ok(!ev.some((e) => e.type === 'done'));
});

test('/generate refuses unfinished cards before calling the AI', async () => {
  let called = false;
  nextGenerate = async () => {
    called = true;
  };
  const r = await call('/generate', { ...genBody, stack: { ...stack, language: null } });
  assert.equal(r.status, 400);
  assert.equal(called, false);
});

test('errors carry a code only; SDK messages (which could hold secrets) are not forwarded', async () => {
  nextGenerate = async () => {
    throw new Error(`boom ${SECRET_KEY}`);
  };
  const ev = events((await call('/generate', genBody)).text);
  assert.deepEqual(ev.at(-1), { type: 'error', code: 'server-error' });
});

test('oversized and malformed bodies are rejected', async () => {
  const big = await call('/analyze', { capture: { tree: { t: 'body', c: ['x'.repeat(5 * 1024 * 1024)] } } });
  assert.equal(big.status, 413);
  assert.equal((await call('/analyze', [1, 2])).status, 400);
  assert.equal((await call('/nope', {})).status, 404);
});

test('the API key never appears in any response body or header', () => {
  assert.ok(bodies.length > 10);
  bodies.forEach((b) => assert.ok(!b.includes(SECRET_KEY)));
});
