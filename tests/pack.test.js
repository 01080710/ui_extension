'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const CFG = require('../src/config.js');
const PC = require('../src/pack-core.js');
const CAP = require('../src/pack-capture.js');
const { read } = require('./helpers.js');

const P = CFG.PACK;
const [fw0, fw1] = P.stack.framework.map((x) => x.id);
const [lang0] = P.stack.language.map((x) => x.id);
const [style0] = P.stack.styling.map((x) => x.id);
const [mode0, mode1] = P.assetModes.map((x) => x.id);
const fullStack = { framework: fw0, language: lang0, styling: style0 };
const fullAssets = Object.fromEntries(P.assetKinds.map((k) => [k.id, mode0]));
const t = (key, subs) => (subs ? `${key}(${subs.join(',')})` : key);
const q = (id, required = true, options = ['a', 'b']) => ({ id, question: `Q ${id}?`, options, required });
const ready = (extra = {}) => ({ stack: { ...fullStack }, assets: { ...fullAssets }, questions: [], answers: {}, ...extra });

// ------------------------------------------------------------------ sanitising

test('pack: analysis is whitelisted against config', () => {
  const a = PC.sanitizeAnalysis(
    {
      summary: 'ok\u0000line',
      suggested: { stack: { framework: fw0, language: 'cobol', styling: style0, extra: 1 }, assets: { images: 'steal', fonts: mode0 } },
      questions: [q('one'), q('two', false), q('bad id!'), q('three', true, ['only one'])],
    },
    P,
  );
  assert.equal(a.summary, 'ok line');
  assert.deepEqual(a.suggested.stack, { framework: fw0, language: null, styling: style0 });
  assert.equal(a.suggested.assets.images, null);
  assert.equal(a.suggested.assets.fonts, mode0);
  assert.deepEqual(a.questions.map((x) => x.id), ['one'], 'only valid, required questions reach card C');
});

test('pack: card C shows at most maxRequiredQuestions', () => {
  const many = Array.from({ length: P.maxRequiredQuestions + 3 }, (_, i) => q(`q${i}`));
  assert.equal(PC.sanitizeAnalysis({ questions: many }, P).questions.length, P.maxRequiredQuestions);
});

test('pack: hostile input never throws', () => {
  [null, undefined, 42, 'x', [], { suggested: 'x', questions: 'x' }, { __proto__: { summary: 'inherited' } }].forEach((raw) => {
    const a = PC.sanitizeAnalysis(raw, P);
    assert.equal(a.summary, '');
    assert.deepEqual(a.questions, []);
  });
});

// ------------------------------------------------------------------ defaults

test('pack: last choice wins over the AI suggestion, field by field', () => {
  const suggested = { stack: { framework: fw1, language: lang0, styling: style0 }, assets: { images: mode1, fonts: mode1, icons: mode1 } };
  const last = { stack: { framework: fw0 }, assets: { images: mode0 } };
  const d = PC.pickDefaults(last, suggested, P);
  assert.equal(d.stack.framework, fw0, 'last');
  assert.equal(d.stack.language, lang0, 'suggested');
  assert.equal(d.assets.images, mode0, 'last');
  assert.equal(d.assets.fonts, mode1, 'suggested');
});

test('pack: nothing known → fields stay unset (⚠️)', () => {
  const d = PC.pickDefaults(null, { stack: {}, assets: {} }, P);
  assert.ok(Object.values(d.stack).every((v) => v === null));
});

// ------------------------------------------------------------------ the primary button

test('pack: complete cards → nothing pending → confirm allowed', () => {
  assert.deepEqual(PC.pendingItems(ready(), P), []);
  ['a', 'b', 'c'].forEach((c) => assert.equal(PC.isCardComplete(ready(), c, P), true));
});

test('pack: pending counts every missing field and unanswered question, in card order', () => {
  const s = ready({ stack: { ...fullStack, language: null }, questions: [q('x'), q('y')], answers: { y: 'a' } });
  assert.deepEqual(PC.pendingItems(s, P), [{ card: 'a', id: 'language' }, { card: 'c', id: 'x' }]);
  assert.equal(PC.isCardComplete(s, 'b', P), true);
  assert.equal(PC.isCardComplete(s, 'c', P), false);
});

test('pack: an answer that is not one of the options does not count', () => {
  assert.equal(PC.pendingItems(ready({ questions: [q('x')], answers: { x: 'zzz' } }), P).length, 1);
});

// ------------------------------------------------------------------ need_clarification

test('pack: clarification adds questions to card C as required', () => {
  const s = ready({ questions: [q('x')], answers: { x: 'a' } });
  const r = PC.applyClarification(s, [q('y', false)], P);
  assert.deepEqual(r.questions.map((x) => [x.id, x.required]), [['x', true], ['y', true]]);
  assert.equal(r.added, 1);
  assert.deepEqual(r.answers, { x: 'a' }, 'earlier answers are kept');
  assert.equal(PC.pendingItems({ ...s, ...r }, P).length, 1);
});

test('pack: a re-asked question clears its old answer (no loop on the same reply)', () => {
  const s = ready({ questions: [q('x')], answers: { x: 'a' } });
  const r = PC.applyClarification(s, [q('x', true, ['c', 'd'])], P);
  assert.deepEqual(r.answers, {});
  assert.deepEqual(r.questions[0].options, ['c', 'd']);
});

test('pack: clarification with nothing valid adds nothing', () => {
  assert.equal(PC.applyClarification(ready(), [{ id: '!!' }], P).added, 0);
});

test('pack: card C never grows past maxQuestions and keeps the new ones', () => {
  const old = Array.from({ length: P.maxQuestions }, (_, i) => q(`o${i}`));
  const r = PC.applyClarification(ready({ questions: old }), [q('n1'), q('n2')], P);
  assert.equal(r.questions.length, P.maxQuestions);
  assert.ok(['n1', 'n2'].every((id) => r.questions.some((x) => x.id === id)));
});

// ------------------------------------------------------------------ summaries & request

test('pack: card A summary reads "framework + styling · language"', () => {
  const s = PC.stackSummary(fullStack, P, t);
  const msg = (list, id) => list.find((x) => x.id === id).msg;
  assert.equal(s, `${msg(P.stack.framework, fw0)} + ${msg(P.stack.styling, style0)} · ${msg(P.stack.language, lang0)}`);
  assert.match(PC.stackSummary({}, P, t), /—/);
});

test('pack: generate request carries only decisions and answered questions', () => {
  const s = ready({ questions: [q('x'), q('y')], answers: { x: 'b' }, capture: { secret: 1 } });
  const r = PC.buildGenerateRequest(s);
  assert.deepEqual(r.answers, [{ id: 'x', question: 'Q x?', answer: 'b' }]);
  assert.equal(r.capture, undefined);
});

// ------------------------------------------------------------------ session restore

test('pack: session restores only for the same host and within the age limit', () => {
  const raw = { host: 'a.com', savedAt: 1000, capture: { tree: {} }, stack: fullStack, assets: fullAssets, questions: [q('x')], answers: { x: 'a' } };
  assert.ok(PC.sanitizeSession(raw, { host: 'a.com', now: 2000, PACK: P }));
  assert.equal(PC.sanitizeSession(raw, { host: 'b.com', now: 2000, PACK: P }), null);
  assert.equal(PC.sanitizeSession(raw, { host: 'a.com', now: 1000 + P.sessionMaxAgeMs + 1, PACK: P }), null);
  assert.equal(PC.sanitizeSession({ ...raw, savedAt: 9999 }, { host: 'a.com', now: 2000, PACK: P }), null, 'future');
  assert.equal(PC.sanitizeSession({ ...raw, capture: null }, { host: 'a.com', now: 2000, PACK: P }), null);
});

test('pack: zip names from the server are validated', () => {
  assert.equal(PC.safeZipName('uix-pack-a-com.zip', 'f.zip'), 'uix-pack-a-com.zip');
  ['../x.zip', 'a/b.zip', 'x.exe', '', null, 'C:\\x.zip'].forEach((n) => assert.equal(PC.safeZipName(n, 'f.zip'), 'f.zip', String(n)));
});

// ------------------------------------------------------------------ capture helpers

test('pack capture: URLs lose query/hash; trackers and non-http are refused', () => {
  const tr = P.capture.trackerHosts;
  assert.equal(CAP.cleanUrl('/img/a.png?token=secret#x', 'https://shop.tw/p', tr), 'https://shop.tw/img/a.png');
  assert.equal(CAP.cleanUrl('https://www.google-analytics.com/collect?v=1', undefined, tr), null);
  assert.equal(CAP.cleanUrl('https://stats.g.doubleclick.net/p.gif', undefined, tr), null, 'subdomain');
  assert.equal(CAP.cleanUrl('javascript:alert(1)', undefined, tr), null);
  assert.equal(CAP.cleanUrl('data:image/png;base64,AAAA', undefined, tr), null);
  assert.equal(CAP.isTrackerHost('notdoubleclick.net', tr), false, 'lookalike');
});

// ------------------------------------------------------------------ config ↔ locales ↔ code

test('pack: every pack message key used in pack-ui exists in every locale', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { ROOT } = require('./helpers.js');
  const keys = new Set([...read('src/pack-ui.js').matchAll(/'(pack[A-Z][A-Za-z]+)'/g)].map((m) => m[1]));
  keys.add('packAssetSummary');
  fs.readdirSync(path.join(ROOT, '_locales')).forEach((l) => {
    const msgs = JSON.parse(read(`_locales/${l}/messages.json`));
    keys.forEach((k) => assert.ok(msgs[k]?.message, `${l}: ${k}`));
  });
});

test('pack: config lists are well-formed and unique', () => {
  const lists = [...Object.values(P.stack), P.stackFields, P.assetKinds, P.assetModes, P.phases];
  lists.forEach((list) => {
    assert.ok(list.length >= 2);
    assert.equal(new Set(list.map((x) => x.id)).size, list.length);
    list.forEach((x) => assert.match(x.id, /^[a-z][a-z0-9-]*$/));
  });
  assert.deepEqual(P.stackFields.map((f) => f.id).sort(), Object.keys(P.stack).sort());
  assert.deepEqual(P.phases.map((p) => p.id), ['analyze', 'generate', 'pack'], 'progress card order');
});
