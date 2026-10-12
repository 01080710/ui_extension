'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const CFG = require('../../src/config.js');
const { createClaude, withRetry, ClaudeError, Anthropic } = require('../lib/claude.js');

const P = CFG.PACK;
const quiet = { warn() {}, error() {}, log() {} };
const env = { ANTHROPIC_API_KEY: 'sk-test', CLAUDE_MODEL: 'claude-sonnet-5-5' };

// Instances without calling SDK constructors (their signatures change between versions).
const apiError = (Cls, status, headers = {}) => Object.assign(Object.create(Cls.prototype), { status, headers, name: Cls.name });

function fakeClient(script) {
  const calls = [];
  const next = async (params) => {
    calls.push(JSON.parse(JSON.stringify(params)));
    const r = script.shift();
    if (r instanceof Error || r instanceof Anthropic.APIError) throw r;
    return typeof r === 'function' ? r(params) : r;
  };
  return { calls, beta: { messages: { create: next, stream: (p) => ({ finalMessage: () => next(p) }) } } };
}

const toolMsg = (name, input, stop = 'tool_use') => ({
  stop_reason: stop,
  content: [{ type: 'tool_use', id: 'toolu_1', name, input }],
});
const textMsg = (text) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text }] });
const stack = { framework: P.stack.framework[0].id, language: P.stack.language[0].id, styling: P.stack.styling[0].id };
const assets = Object.fromEntries(P.assetKinds.map((k) => [k.id, P.assetModes[0].id]));
const q = (id, required = true) => ({ id, question: `${id}?`, options: ['a', 'b'], required });
const goodFiles = [
  { path: 'package.json', content: JSON.stringify({ scripts: { dev: 'vite' } }) },
  { path: 'index.html', content: '<div id="root"></div>' },
  { path: 'src/main.tsx', content: 'export {}' },
];
const make = (script) => {
  const client = fakeClient(script);
  return { client, claude: createClaude({ env, cfg: CFG, client, sleep: async () => {}, log: quiet }) };
};

// ------------------------------------------------------------------ retry

test('retry: 429 is retried 3 times with exponential backoff, then thrown', async () => {
  const waits = [];
  let n = 0;
  const err = apiError(Anthropic.RateLimitError, 429);
  await assert.rejects(
    withRetry(async () => { n += 1; throw err; }, { sleep: async (ms) => waits.push(ms), log: quiet, baseMs: 100 }),
    (e) => e === err,
  );
  assert.equal(n, 4, '1 call + 3 retries');
  assert.equal(waits.length, 3);
  waits.forEach((w, i) => assert.ok(w >= 100 * 2 ** i * 0.5 && w <= 100 * 2 ** i, `wait ${i}: ${w}`));
});

test('retry: succeeds after transient 529 / connection errors', async () => {
  const errs = [apiError(Anthropic.APIError, 529), apiError(Anthropic.APIConnectionError, undefined)];
  const r = await withRetry(async () => { if (errs.length) throw errs.shift(); return 'ok'; }, { sleep: async () => {}, log: quiet });
  assert.equal(r, 'ok');
});

test('retry: 400 / 401 are not retried; retry-after is honoured', async () => {
  let n = 0;
  await assert.rejects(withRetry(async () => { n += 1; throw apiError(Anthropic.BadRequestError, 400); }, { sleep: async () => {}, log: quiet }));
  assert.equal(n, 1);
  const waits = [];
  const errs = [apiError(Anthropic.RateLimitError, 429, { 'retry-after': '2' })];
  await withRetry(async () => { if (errs.length) throw errs.shift(); return 1; }, { sleep: async (ms) => waits.push(ms), log: quiet });
  assert.deepEqual(waits, [2000]);
});

// ------------------------------------------------------------------ analyze

test('analyze: tool result is validated; extra required questions are demoted', async () => {
  const { client, claude } = make([
    toolMsg('report_analysis', {
      suggested: { stack, assets: { ...assets, images: 'steal' } },
      summary: 'Hero + nav',
      questions: [q('a'), q('b'), q('c'), q('d'), q('e', false)],
    }),
  ]);
  const r = await claude.analyze({ capture: {}, locale: 'zh-TW' });
  assert.deepEqual(r.suggested.stack, stack);
  assert.equal(r.suggested.assets.images, null);
  assert.equal(r.questions.filter((x) => x.required).length, P.maxRequiredQuestions);
  const [params] = client.calls;
  assert.deepEqual(params.tool_choice, { type: 'auto' }, 'sonnet-5-5 rejects forced tool_choice');
  assert.equal(params.tools[0].strict, true);
  assert.equal(params.model, 'claude-sonnet-5-5');
  assert.equal(params.fallbacks, 'default');
  assert.deepEqual(params.betas, ['server-side-fallback-2026-07-01']);
});

test('analyze: a reply without the tool gets one reminder turn', async () => {
  const { client, claude } = make([textMsg('Sure!'), toolMsg('report_analysis', { suggested: { stack, assets }, summary: '', questions: [] })]);
  await claude.analyze({ capture: {}, locale: 'en' });
  assert.equal(client.calls.length, 2);
  assert.equal(client.calls[1].messages.at(-1).role, 'user');
});

test('analyze: refusal is reported, not parsed', async () => {
  const { claude } = make([{ stop_reason: 'refusal', content: [] }]);
  await assert.rejects(claude.analyze({ capture: {}, locale: 'en' }), (e) => e instanceof ClaudeError && e.code === 'refusal');
});

// ------------------------------------------------------------------ generate

const req = { capture: {}, stack, assets, answers: [], summary: '', locale: 'en', bundledImages: [] };

test('generate: valid project is returned', async () => {
  const { client, claude } = make([toolMsg('emit_project', { files: goodFiles })]);
  const r = await claude.generate(req);
  assert.equal(r.status, 'ok');
  assert.equal(r.files.length, 3);
  assert.ok(client.calls[0].tools.every((t) => t.eager_input_streaming === true));
});

test('generate: need_clarification returns questions (all required)', async () => {
  const { claude } = make([toolMsg('need_clarification', { questions: [q('menu', false)] })]);
  const r = await claude.generate(req);
  assert.equal(r.status, 'need_clarification');
  assert.deepEqual(r.questions.map((x) => [x.id, x.required]), [['menu', true]]);
});

test('generate: unsafe paths reject the whole generation', async () => {
  for (const path of ['../evil.js', '/etc/passwd', 'C:/x.js', 'src\\x.js', 'a/../../b', '~/x']) {
    const { claude } = make([toolMsg('emit_project', { files: [...goodFiles, { path, content: 'x' }] })]);
    await assert.rejects(claude.generate(req), (e) => e.code === 'unsafe-path', path);
  }
});

test('generate: a fixable problem gets one repair turn with an error tool_result', async () => {
  const noDev = [{ path: 'package.json', content: '{"scripts":{}}' }, goodFiles[1]];
  const { client, claude } = make([toolMsg('emit_project', { files: noDev }), toolMsg('emit_project', { files: goodFiles })]);
  const r = await claude.generate(req);
  assert.equal(r.status, 'ok');
  const last = client.calls[1].messages.at(-1).content[0];
  assert.equal(last.type, 'tool_result');
  assert.equal(last.is_error, true);
  assert.match(last.content, /dev/);
});

test('generate: truncated output is an error, never zipped', async () => {
  const { claude } = make([toolMsg('emit_project', { files: goodFiles }, 'max_tokens')]);
  await assert.rejects(claude.generate(req), (e) => e.code === 'incomplete-project');
});
