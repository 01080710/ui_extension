/**
 * Component pack — decision-card view inside the style panel's closed shadow root.
 *
 *   export click → loading card → (analysis) → cards A/B/(C) pre-filled → confirm
 *   → one progress card (analyse → generate → pack) → .zip downloaded → done card
 *
 * Best case is two clicks: the pack button, then "confirm and generate".
 * Network goes through the background worker only; this file never calls fetch.
 * DOM is built with the panel's h() factory — createElement/textContent, no HTML strings.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.UIX_PACK_UI = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Reuses the panel variables (--p-*) and classes (.panel, .apply, .ghost, .close, .hint).
  const css = `
    .panel[hidden] { display: none; }
    .pack { width: 340px; gap: 10px; padding-bottom: 0; }
    .cards { display: grid; gap: 8px; }
    .summary { margin: 0; color: var(--p-muted); font-size: 12px; }
    .card {
      border: 1px solid var(--p-border); border-radius: 10px; scroll-margin: 12px;
      background: color-mix(in srgb, var(--p-bg) 94%, var(--p-fg));
    }
    .card.warn { border-color: color-mix(in srgb, var(--p-accent) 60%, var(--p-border)); }
    .card-head {
      display: flex; align-items: center; gap: 8px; width: 100%; margin: 0;
      padding: 10px 12px; border: 0; border-radius: 10px; background: transparent; text-align: start;
    }
    button.card-head { cursor: pointer; }
    button.card-head:hover { background: color-mix(in srgb, var(--p-border) 40%, transparent); }
    .chev { flex: none; width: 10px; color: var(--p-muted); transition: transform 120ms ease; }
    .card-head[aria-expanded="true"] .chev { transform: rotate(90deg); }
    .card-title { flex: none; font-weight: 600; }
    .card-sum {
      flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      color: var(--p-muted); font-size: 12px;
    }
    .badge { flex: none; margin-inline-start: auto; font-size: 13px; }
    .card-body { display: grid; gap: 12px; padding: 0 12px 12px; }
    .card-body[hidden] { display: none; }
    .card-body legend { margin-bottom: 6px; }
    .chips { display: flex; flex-wrap: wrap; gap: 6px; }
    .chip { position: relative; display: inline-flex; cursor: pointer; }
    .chip input { position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; opacity: 0; cursor: pointer; }
    .chip span { padding: 4px 10px; border: 1px solid var(--p-border); border-radius: 999px; font-size: 12px; }
    .chip input:checked + span { background: var(--p-accent); color: var(--p-accent-fg); border-color: var(--p-accent); }
    .chip input:focus-visible + span { outline: 2px solid var(--p-accent); outline-offset: 2px; }
    .loading { display: flex; align-items: center; gap: 10px; padding: 14px 12px; }
    .spinner {
      flex: none; width: 16px; height: 16px; border-radius: 50%;
      border: 2px solid var(--p-border); border-top-color: var(--p-accent);
      animation: uix-pack-spin 0.8s linear infinite;
    }
    @keyframes uix-pack-spin { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) { .spinner { animation-duration: 2.4s; } }
    .steps { display: grid; gap: 8px; margin: 0; padding: 0 12px 12px; list-style: none; }
    .step { display: flex; align-items: center; gap: 8px; color: var(--p-muted); }
    .step.active, .step.done { color: var(--p-fg); }
    .step-mark { flex: none; width: 16px; display: inline-flex; justify-content: center; }
    .msg { margin: 0; padding: 0 12px; }
    .card .actions { padding: 0 12px 12px; }
    .token { display: grid; gap: 8px; padding: 0 12px 12px; }
    .token input {
      min-width: 0; padding: 6px 8px; border: 1px solid var(--p-border); border-radius: 6px; background: var(--p-bg);
    }
    .packfoot {
      position: sticky; bottom: 0; display: grid; gap: 6px; margin: 0 -16px; padding: 10px 16px 16px;
      background: var(--p-bg); border-top: 1px solid var(--p-border);
    }
    .packfoot .apply { width: 100%; }
    .apply[aria-disabled="true"] { opacity: 0.55; }
    .pack > .status:empty { display: none; }
  `;

  const TOKEN = /^[\x21-\x7e]{24,256}$/;
  // Error code (background / server) → message key; unknown codes fall back to packErrServer.
  const ERROR_MSG = {
    'no-token': 'packErrNoToken',
    unauthorized: 'packErrUnauthorized',
    'server-down': 'packErrServerDown',
    timeout: 'packErrTimeout',
    'rate-limit': 'packErrRateLimit',
    'too-large': 'packErrTooLarge',
    'bad-response': 'packErrBadResponse',
    'unsafe-path': 'packErrBadResponse',
    'incomplete-project': 'packErrBadResponse',
    refusal: 'packErrRefusal',
    'capture-failed': 'packErrCapture',
    'extension-reloaded': 'packErrExtension',
  };

  function create({ cfg, core: PC, host, h, t, form, capture, onClose }) {
    const PACK = cfg.PACK;
    const MT = cfg.MESSAGE_TYPES;
    const S = PACK.storage;
    let runId = 0;
    let state = null;

    const view = h('div', { attrs: { class: 'panel pack', role: 'region', 'aria-label': t('packTitle') } });
    view.hidden = true;

    // ------------------------------------------------------------ storage (untrusted on read)

    const store = (area) => ({
      async get(key) {
        try {
          return (await chrome.storage[area].get(key))[key];
        } catch {
          return undefined; // session not exposed to content scripts, or context invalidated
        }
      },
      async set(key, value) {
        try {
          await chrome.storage[area].set({ [key]: value });
        } catch {
          /* best effort: the flow still works without persistence */
        }
      },
      async remove(key) {
        try {
          await chrome.storage[area].remove(key);
        } catch {
          /* ignore */
        }
      },
    });
    const local = store('local');
    const session = store('session');

    function saveSession() {
      const { capture: cap, summary, stack, assets, questions, answers } = state;
      session.set(S.session, { host, savedAt: Date.now(), capture: cap, summary, stack, assets, questions, answers });
    }

    const send = (msg) =>
      chrome.runtime.sendMessage(msg).catch(() => ({ ok: false, code: 'extension-reloaded' }));

    // ------------------------------------------------------------ flow

    const blank = () => ({
      phase: 'idle',
      capture: null,
      summary: '',
      stack: {},
      assets: {},
      questions: [],
      answers: {},
      expanded: { a: false, b: false },
      progress: null,
      error: null,
      retry: null,
      filename: '',
      notice: '',
    });

    function show() {
      form.hidden = true;
      view.hidden = false;
    }

    function back() {
      runId += 1; // late responses from the abandoned run are ignored
      view.hidden = true;
      form.hidden = false;
      const btn = form.querySelector('[data-pack-entry]');
      if (btn) btn.focus({ preventScroll: true });
    }

    async function start({ fresh = false } = {}) {
      runId += 1;
      const run = runId;
      show();
      const token = await local.get(S.token);
      if (run !== runId) return;
      if (typeof token !== 'string' || !TOKEN.test(token)) {
        state = { ...blank(), phase: 'token' };
        render();
        return;
      }
      if (!fresh) {
        const restored = PC.sanitizeSession(await session.get(S.session), { host, now: Date.now(), PACK });
        if (run !== runId) return;
        if (restored) {
          state = { ...blank(), ...restored, phase: 'deciding' };
          render();
          return;
        }
      }
      analyze();
    }

    async function analyze() {
      const run = ++runId;
      state = { ...blank(), phase: 'analyzing' };
      render();
      try {
        state.capture = capture();
      } catch {
        fail('capture-failed', analyze);
        return;
      }
      const res = await send({ type: MT.packAnalyze, capture: state.capture, locale: chrome.i18n.getUILanguage() });
      if (run !== runId) return;
      if (!res || !res.ok) {
        fail(res && res.code, analyze);
        return;
      }
      const analysis = PC.sanitizeAnalysis(res.analysis, PACK);
      const last = PC.sanitizeLast(await local.get(S.last), PACK);
      if (run !== runId) return;
      state = {
        ...state,
        ...PC.pickDefaults(last, analysis.suggested, PACK),
        phase: 'deciding',
        summary: analysis.summary,
        questions: analysis.questions,
        answers: {},
      };
      saveSession();
      render();
    }

    async function generate() {
      if (PC.pendingItems(state, PACK).length) {
        revealFirstPending(); // never generate with an unfinished card
        return;
      }
      const run = ++runId;
      local.set(S.last, PC.sanitizeLast(state, PACK));
      state = { ...state, phase: 'generating', progress: PACK.phases[1].id, notice: '' };
      render();
      const res = await send({
        type: MT.packGenerate,
        capture: state.capture,
        summary: state.summary,
        locale: chrome.i18n.getUILanguage(),
        ...PC.buildGenerateRequest(state),
      });
      if (run !== runId) return;
      if (res && res.ok && res.status === 'need_clarification') {
        const next = PC.applyClarification(state, res.questions, PACK);
        if (!next.added) {
          fail('bad-response', generate);
          return;
        }
        state = { ...state, ...next, phase: 'deciding', notice: t('packClarifyNotice', [String(next.added)]) };
        saveSession();
        render();
        revealFirstPending();
        return;
      }
      if (!res || !res.ok || res.status !== 'done' || typeof res.zip !== 'string') {
        fail(res && res.code, generate);
        return;
      }
      state.progress = PACK.phases[2].id;
      render();
      const filename = PC.safeZipName(res.filename, PACK.defaultZipName);
      try {
        downloadZip(res.zip, filename);
      } catch {
        fail('bad-response', generate);
        return;
      }
      session.remove(S.session);
      state = { ...state, phase: 'done', filename };
      render();
    }

    function fail(code, retry) {
      state = { ...state, phase: 'error', error: typeof code === 'string' ? code : 'server-error', retry };
      render();
    }

    function downloadZip(b64, filename) {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/zip' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.rel = 'noopener';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    }

    // Progress pushed by the background worker while /generate streams.
    chrome.runtime.onMessage.addListener((msg, sender) => {
      if (sender.id !== chrome.runtime.id || !msg || msg.type !== MT.packProgress) return;
      if (!state || state.phase !== 'generating' || !PACK.phases.some((p) => p.id === msg.phase)) return;
      state.progress = msg.phase;
      render();
    });

    // ------------------------------------------------------------ render

    function render() {
      const focusKey = view.getRootNode().activeElement?.dataset?.key;
      view.replaceChildren(head(), ...body(), h('div', { attrs: { class: 'status', role: 'status', 'aria-live': 'polite' }, text: state.notice }));
      if (focusKey) {
        const el = [...view.querySelectorAll('[data-key]')].find((x) => x.dataset.key === focusKey);
        if (el) el.focus({ preventScroll: true });
      }
    }

    function head() {
      const backBtn = h('button', { attrs: { type: 'button', class: 'close', 'aria-label': t('packBack'), 'data-key': 'back' }, text: '‹' });
      const closeBtn = h('button', { attrs: { type: 'button', class: 'close', 'aria-label': t('closePanel') }, text: '×' });
      backBtn.addEventListener('click', back);
      closeBtn.addEventListener('click', onClose);
      return h('div', { attrs: { class: 'head' } }, [backBtn, h('p', { attrs: { class: 'title' }, text: t('packTitle') }), closeBtn]);
    }

    function body() {
      switch (state.phase) {
        case 'token':
          return [tokenCard()];
        case 'analyzing':
          return [loadingCard(t('packAnalyzing'))];
        case 'deciding':
          return deciding();
        case 'generating':
          return [progressCard()];
        case 'done':
          return [doneCard()];
        case 'error':
          return [errorCard()];
        default:
          return [];
      }
    }

    function button(label, onClick, { cls = 'ghost', key } = {}) {
      const b = h('button', { attrs: { type: 'button', class: cls, ...(key ? { 'data-key': key } : {}) }, text: label });
      b.addEventListener('click', onClick);
      return b;
    }

    function plainCard(title, children, { warn = false } = {}) {
      return h('section', { attrs: { class: warn ? 'card warn' : 'card', 'aria-label': title } }, [
        h('div', { attrs: { class: 'card-head' } }, [h('span', { attrs: { class: 'card-title' }, text: title })]),
        ...children,
      ]);
    }

    function loadingCard(label) {
      return h('section', { attrs: { class: 'card', 'aria-busy': 'true' } }, [
        h('div', { attrs: { class: 'loading' } }, [h('span', { attrs: { class: 'spinner', 'aria-hidden': 'true' } }), h('span', { text: label })]),
      ]);
    }

    function tokenCard() {
      const input = h('input', {
        props: { type: 'password', autocomplete: 'off', spellcheck: false },
        attrs: { 'aria-label': t('packTokenLabel'), 'data-key': 'token' },
      });
      const err = h('span', { attrs: { class: 'hint', role: 'alert' } });
      const tokenForm = h('form', { attrs: { class: 'token' } }, [
        h('span', { attrs: { class: 'hint' }, text: t('packTokenHint') }),
        input,
        err,
        h('div', { attrs: { class: 'actions' } }, [h('button', { attrs: { type: 'submit', class: 'apply' }, text: t('packTokenSave') })]),
      ]);
      tokenForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const v = input.value.trim();
        if (!TOKEN.test(v)) {
          err.textContent = t('packTokenInvalid');
          return;
        }
        await local.set(S.token, v);
        start();
      });
      setTimeout(() => input.focus({ preventScroll: true }), 0);
      return plainCard(t('packTokenTitle'), [tokenForm], { warn: true });
    }

    function progressCard() {
      const at = PACK.phases.findIndex((p) => p.id === state.progress);
      const steps = PACK.phases.map((p, i) => {
        const status = i < at ? 'done' : i === at ? 'active' : 'todo';
        const mark =
          status === 'active'
            ? h('span', { attrs: { class: 'spinner', 'aria-hidden': 'true' } })
            : h('span', { attrs: { 'aria-hidden': 'true' }, text: status === 'done' ? '✓' : '○' });
        return h('li', { attrs: { class: `step ${status}`, ...(status === 'active' ? { 'aria-current': 'step' } : {}) } }, [
          h('span', { attrs: { class: 'step-mark' } }, [mark]),
          h('span', { text: t(p.msg) }),
        ]);
      });
      return h('section', { attrs: { class: 'card', 'aria-busy': 'true', 'aria-label': t('packGenerating') } }, [
        h('div', { attrs: { class: 'card-head' } }, [h('span', { attrs: { class: 'card-title' }, text: t('packGenerating') })]),
        h('ol', { attrs: { class: 'steps' } }, steps),
      ]);
    }

    function doneCard() {
      return plainCard(t('packDoneTitle'), [
        h('p', { attrs: { class: 'msg' }, text: t('packDone', [state.filename]) }),
        h('div', { attrs: { class: 'actions' } }, [button(t('packAgain'), () => start({ fresh: true }), { cls: 'apply', key: 'again' })]),
      ]);
    }

    function errorCard() {
      const actions = [];
      if (state.error === 'unauthorized' || state.error === 'no-token') {
        actions.push(button(t('packTokenReset'), async () => {
          await local.remove(S.token);
          start();
        }, { key: 'reset' }));
      }
      if (state.questions.length || state.stack.framework) {
        actions.push(button(t('packBackToCards'), () => {
          state = { ...state, phase: 'deciding' };
          render();
        }, { key: 'cards' }));
      }
      if (state.retry) actions.push(button(t('packRetry'), state.retry, { cls: 'apply', key: 'retry' }));
      return plainCard(t('packErrTitle'), [
        h('p', { attrs: { class: 'msg', role: 'alert' }, text: t(ERROR_MSG[state.error] || 'packErrServer') }),
        h('div', { attrs: { class: 'actions' } }, actions),
      ], { warn: true });
    }

    // ------------------------------------------------------------ decision cards

    function update(patch) {
      state = { ...state, ...patch };
      saveSession();
      render();
    }

    function chips(group, legend, options, selected, onPick) {
      const name = `pack-${group}`;
      return h('fieldset', { attrs: { 'data-group': group } }, [
        h('legend', { text: legend }),
        h(
          'div',
          { attrs: { class: 'chips' } },
          options.map((o) => {
            const input = h('input', {
              props: { type: 'radio', name, value: o.value, checked: o.value === selected },
              attrs: { 'data-key': `${group}=${o.value}` },
            });
            input.addEventListener('change', () => onPick(o.value));
            return h('label', { attrs: { class: 'chip' } }, [input, h('span', { text: o.label })]);
          }),
        ),
      ]);
    }

    function card({ key, title, summary, collapsible, children }) {
      const complete = PC.isCardComplete(state, key, PACK);
      const expanded = !collapsible || state.expanded[key];
      const bodyId = `pack-body-${key}`;
      const badge = h('span', {
        attrs: { class: 'badge', role: 'img', 'aria-label': t(complete ? 'packStatusOk' : 'packStatusWarn') },
        text: t(complete ? 'packBadgeOk' : 'packBadgeWarn'),
      });
      const parts = [h('span', { attrs: { class: 'card-title' }, text: title })];
      if (summary) parts.push(h('span', { attrs: { class: 'card-sum' }, text: summary }));
      parts.push(badge);
      let headEl;
      if (collapsible) {
        headEl = h('button', {
          attrs: { type: 'button', class: 'card-head', 'aria-expanded': String(expanded), 'aria-controls': bodyId, 'data-key': `head:${key}` },
        }, [h('span', { attrs: { class: 'chev', 'aria-hidden': 'true' }, text: '›' }), ...parts]);
        headEl.addEventListener('click', () => {
          state.expanded = { ...state.expanded, [key]: !state.expanded[key] };
          render();
        });
      } else {
        headEl = h('div', { attrs: { class: 'card-head' } }, parts);
      }
      const bodyEl = h('div', { attrs: { class: 'card-body', id: bodyId } }, children);
      bodyEl.hidden = !expanded;
      return h('section', { attrs: { class: complete ? 'card' : 'card warn', 'data-card': key, 'aria-label': title } }, [headEl, bodyEl]);
    }

    function deciding() {
      const label = (list) => list.map((x) => ({ value: x.id, label: t(x.msg) }));
      const cardA = card({
        key: 'a',
        title: t('packCardA'),
        summary: PC.stackSummary(state.stack, PACK, t),
        collapsible: true,
        children: PACK.stackFields.map((f) =>
          chips(`a:${f.id}`, t(f.msg), label(PACK.stack[f.id]), state.stack[f.id], (v) =>
            update({ stack: { ...state.stack, [f.id]: v } })),
        ),
      });
      const cardB = card({
        key: 'b',
        title: t('packCardB'),
        summary: PC.assetsSummary(state.assets, PACK, t),
        collapsible: true,
        children: PACK.assetKinds.map((k) =>
          chips(`b:${k.id}`, t(k.msg), label(PACK.assetModes), state.assets[k.id], (v) =>
            update({ assets: { ...state.assets, [k.id]: v } })),
        ),
      });
      const cards = [cardA, cardB];
      if (state.questions.length) {
        cards.push(card({
          key: 'c',
          title: t('packCardC'),
          collapsible: false,
          children: state.questions.map((q) =>
            chips(`c:${q.id}`, q.question, q.options.map((o) => ({ value: o, label: o })), state.answers[q.id], (v) =>
              update({ answers: { ...state.answers, [q.id]: v } })),
          ),
        }));
      }

      const pending = PC.pendingItems(state, PACK);
      const primary = button(
        pending.length ? t('packPending', [String(pending.length)]) : t('packConfirm'),
        () => (pending.length ? revealFirstPending() : generate()),
        { cls: 'apply', key: 'primary' },
      );
      primary.setAttribute('aria-disabled', String(pending.length > 0));

      const out = [];
      if (state.summary) out.push(h('p', { attrs: { class: 'summary' }, text: state.summary }));
      out.push(h('div', { attrs: { class: 'cards' } }, cards));
      out.push(h('div', { attrs: { class: 'packfoot' } }, [primary]));
      return out;
    }

    /** Expand and scroll to the first unfinished card, focusing its first choice. */
    function revealFirstPending() {
      const [first] = PC.pendingItems(state, PACK);
      if (!first) return;
      if (first.card !== 'c') state.expanded = { ...state.expanded, [first.card]: true };
      render();
      const cardEl = [...view.querySelectorAll('[data-card]')].find((x) => x.dataset.card === first.card);
      if (cardEl) cardEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      const group = [...view.querySelectorAll('[data-group]')].find((x) => x.dataset.group === `${first.card}:${first.id}`);
      const input = group && group.querySelector('input');
      if (input) input.focus({ preventScroll: true });
    }

    return { view, start, isActive: () => !view.hidden };
  }

  return { css, create };
});
