/**
 * Component pack — pure logic, no chrome.* and no DOM, so it runs under node:test.
 * Everything from the server or from storage is untrusted: every field is
 * whitelisted against config before the UI sees it.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.UIX_PACK_CORE = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const own = (o, k) => (o && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);
  const pickId = (v, list) => (list.some((x) => x.id === v) ? v : null);
  const cleanText = (v, max) =>
    typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max) : '';
  const QUESTION_ID = /^[A-Za-z0-9_-]{1,40}$/;
  const ZIP_NAME = /^[A-Za-z0-9._-]{1,80}\.zip$/;

  function sanitizeStack(raw, PACK) {
    return Object.fromEntries(PACK.stackFields.map((f) => [f.id, pickId(own(raw, f.id), PACK.stack[f.id])]));
  }

  function sanitizeAssets(raw, PACK) {
    return Object.fromEntries(PACK.assetKinds.map((k) => [k.id, pickId(own(raw, k.id), PACK.assetModes)]));
  }

  /** Valid questions only: safe id, non-empty text, 2+ distinct options. */
  function sanitizeQuestions(raw, PACK, { requiredOnly = false, max = PACK.maxQuestions } = {}) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const q of raw) {
      const id = own(q, 'id');
      if (typeof id !== 'string' || !QUESTION_ID.test(id) || out.some((x) => x.id === id)) continue;
      const question = cleanText(own(q, 'question'), PACK.maxTextLength);
      const rawOptions = own(q, 'options');
      const options = Array.isArray(rawOptions)
        ? [...new Set(rawOptions.map((o) => cleanText(o, PACK.maxTextLength)).filter(Boolean))].slice(0, PACK.maxOptions)
        : [];
      const required = own(q, 'required') === true;
      if (!question || options.length < 2 || (requiredOnly && !required)) continue;
      out.push({ id, question, options, required });
      if (out.length >= max) break;
    }
    return out;
  }

  /** /analyze response → what the cards need. Card C only ever shows required questions. */
  function sanitizeAnalysis(raw, PACK) {
    const suggested = own(raw, 'suggested');
    return {
      summary: cleanText(own(raw, 'summary'), PACK.maxTextLength),
      suggested: {
        stack: sanitizeStack(own(suggested, 'stack'), PACK),
        assets: sanitizeAssets(own(suggested, 'assets'), PACK),
      },
      questions: sanitizeQuestions(own(raw, 'questions'), PACK, { requiredOnly: true, max: PACK.maxRequiredQuestions }),
    };
  }

  /** Per field: the user's last choice first, then the AI suggestion, else unset (⚠️). */
  function pickDefaults(last, suggested, PACK) {
    const merge = (a, b) => Object.fromEntries(Object.keys(a).map((k) => [k, a[k] || b[k] || null]));
    return {
      stack: merge(sanitizeStack(own(last, 'stack'), PACK), sanitizeStack(own(suggested, 'stack'), PACK)),
      assets: merge(sanitizeAssets(own(last, 'assets'), PACK), sanitizeAssets(own(suggested, 'assets'), PACK)),
    };
  }

  function sanitizeAnswers(raw, questions) {
    const out = {};
    questions.forEach((q) => {
      const v = own(raw, q.id);
      if (q.options.includes(v)) out[q.id] = v;
    });
    return out;
  }

  /**
   * need_clarification: new questions join card C (all treated as required). A question
   * the AI asks again replaces the old one and clears its answer, so the user must
   * answer it again instead of looping on the same reply.
   */
  function applyClarification(state, incoming, PACK) {
    const fresh = sanitizeQuestions(incoming, PACK).map((q) => ({ ...q, required: true }));
    const byId = new Map(state.questions.map((q) => [q.id, q]));
    const answers = { ...state.answers };
    fresh.forEach((q) => {
      byId.set(q.id, q);
      delete answers[q.id];
    });
    let questions = [...byId.values()];
    const freshIds = new Set(fresh.map((q) => q.id));
    while (questions.length > PACK.maxQuestions) {
      const i = questions.findIndex((q) => !freshIds.has(q.id));
      if (i < 0) break;
      delete answers[questions[i].id];
      questions = questions.filter((_, j) => j !== i);
    }
    return { questions: questions.slice(0, PACK.maxQuestions), answers, added: fresh.length };
  }

  /** Unfinished items in card order (A fields, B kinds, C questions). Empty = ready. */
  function pendingItems(state, PACK) {
    const items = [];
    PACK.stackFields.forEach((f) => !state.stack[f.id] && items.push({ card: 'a', id: f.id }));
    PACK.assetKinds.forEach((k) => !state.assets[k.id] && items.push({ card: 'b', id: k.id }));
    state.questions.forEach((q) => !q.options.includes(state.answers[q.id]) && items.push({ card: 'c', id: q.id }));
    return items;
  }

  const isCardComplete = (state, card, PACK) => !pendingItems(state, PACK).some((i) => i.card === card);

  const labelOf = (list, id, t) => {
    const x = list.find((o) => o.id === id);
    return x ? t(x.msg) : '—';
  };

  /** "React + Tailwind · TS" */
  function stackSummary(stack, PACK, t) {
    const { framework, language, styling } = PACK.stack;
    return `${labelOf(framework, stack.framework, t)} + ${labelOf(styling, stack.styling, t)} · ${labelOf(language, stack.language, t)}`;
  }

  function assetsSummary(assets, PACK, t) {
    return PACK.assetKinds
      .map((k) => t('packAssetSummary', [t(k.msg), labelOf(PACK.assetModes, assets[k.id], t)]))
      .join(' · ');
  }

  /** What /generate needs besides the capture: only the user's decisions. */
  function buildGenerateRequest(state) {
    return {
      stack: { ...state.stack },
      assets: { ...state.assets },
      answers: state.questions
        .filter((q) => q.options.includes(state.answers[q.id]))
        .map((q) => ({ id: q.id, question: q.question, answer: state.answers[q.id] })),
    };
  }

  /** chrome.storage.local last choice: stack + assets only. */
  function sanitizeLast(raw, PACK) {
    return { stack: sanitizeStack(own(raw, 'stack'), PACK), assets: sanitizeAssets(own(raw, 'assets'), PACK) };
  }

  /** chrome.storage.session snapshot of an unfinished pack; null when stale or foreign. */
  function sanitizeSession(raw, { host, now, PACK }) {
    const savedAt = own(raw, 'savedAt');
    if (own(raw, 'host') !== host || typeof savedAt !== 'number' || now - savedAt > PACK.sessionMaxAgeMs || savedAt > now) {
      return null;
    }
    const capture = own(raw, 'capture');
    if (!capture || typeof capture !== 'object') return null;
    const questions = sanitizeQuestions(own(raw, 'questions'), PACK);
    return {
      capture,
      summary: cleanText(own(raw, 'summary'), PACK.maxTextLength),
      stack: sanitizeStack(own(raw, 'stack'), PACK),
      assets: sanitizeAssets(own(raw, 'assets'), PACK),
      questions,
      answers: sanitizeAnswers(own(raw, 'answers'), questions),
    };
  }

  const safeZipName = (name, fallback) => (typeof name === 'string' && ZIP_NAME.test(name) ? name : fallback);

  return {
    sanitizeStack,
    sanitizeAssets,
    sanitizeQuestions,
    sanitizeAnalysis,
    sanitizeAnswers,
    pickDefaults,
    applyClarification,
    pendingItems,
    isCardComplete,
    stackSummary,
    assetsSummary,
    buildGenerateRequest,
    sanitizeLast,
    sanitizeSession,
    safeZipName,
  };
});
