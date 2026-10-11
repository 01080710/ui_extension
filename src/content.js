/**
 * Content script: wires config + core + exporter to the page.
 *  - every frame: apply the effective theme; mark floating layers and brand bars;
 *    extend Mode A colours into shadow roots
 *  - top frame only: the style panel (closed Shadow DOM), the U / I keys and the
 *    browser-level shortcut relayed by the background worker
 * DOM is built with createElement/textContent only — never HTML strings.
 */
(() => {
  'use strict';

  const CFG = globalThis.UIX_CONFIG;
  const CORE = globalThis.UIX_CORE;
  const EXPORT = globalThis.UIX_EXPORT;
  const SHADOW = globalThis.UIX_SHADOW;
  if (!CFG || !CORE || !EXPORT || !SHADOW || globalThis.__uixContentLoaded) return;
  globalThis.__uixContentLoaded = true;

  const root = document.documentElement;
  const isTopFrame = window.top === window;
  const { ATTR, STORAGE_KEY } = CFG;
  const sanitizeOpts = {
    themeIds: CFG.THEMES.map((t) => t.id),
    defaults: CFG.DEFAULT_SETTINGS,
    maxHosts: CFG.MAX_EXCLUDED_HOSTS,
  };
  const sanitize = (raw) => CORE.sanitizeSettings(raw, sanitizeOpts);
  const readVar = (name) => getComputedStyle(root).getPropertyValue(name).trim();
  const readBaseBg = () => readVar('--uix-bg');
  const t = (key, subs) => chrome.i18n.getMessage(key, subs) || key;
  const themeLabel = (id) => {
    const theme = CFG.THEMES.find((x) => x.id === id);
    return theme ? t(theme.msg) : '';
  };

  const host = CORE.normalizeHost(CORE.pickTopHost(location.hostname, location.ancestorOrigins)) || '';
  const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

  let settings = sanitize(null);
  let effective = CORE.resolveEffective(settings, { prefersDark: false, host });

  // ---------------------------------------------------------------- storage

  async function loadSettings() {
    try {
      const res = await chrome.storage.sync.get(STORAGE_KEY);
      return sanitize(res[STORAGE_KEY]);
    } catch {
      return sanitize(null); // extension reloaded / context invalidated
    }
  }

  async function saveSettings(next) {
    await chrome.storage.sync.set({ [STORAGE_KEY]: sanitize(next) });
  }

  // ---------------------------------------------------------------- render

  function render() {
    effective = CORE.resolveEffective(settings, { prefersDark: darkQuery.matches, host });
    const active = CORE.applyThemeToRoot(root, effective, CFG, readBaseBg);
    layers.setActive(active);
    panel.sync();
  }

  // Some sites rewrite <html> attributes (SPA navigations, hydration). Re-assert.
  new MutationObserver(() => {
    if (!CORE.isRootInSync(root, effective, CFG)) CORE.applyThemeToRoot(root, effective, CFG, readBaseBg);
  }).observe(root, { attributes: true, attributeFilter: [ATTR.theme, ATTR.enhanced, ATTR.fonts, 'style'] });

  // ---------------------------------------------------------------- brand bars

  /**
   * Find site chrome whose ORIGINAL background is dark/saturated (white icons on a
   * blue nav bar). The theme attribute is lifted for the measurement and put back in
   * the same task, so the browser never paints the un-themed state.
   */
  function markBrandBars(nodes) {
    const { selector, descendantSelector, maxDescendants } = CFG.BRAND_SCAN;
    const candidates = new Set();
    nodes.forEach((n) => {
      if (!n || n.nodeType !== 1) return;
      const hits = n.matches(selector) ? [n] : [];
      hits.push(...n.querySelectorAll(selector));
      hits.forEach((c) => {
        candidates.add(c);
        [...c.querySelectorAll(descendantSelector)].slice(0, maxDescendants).forEach((d) => candidates.add(d));
      });
    });
    const todo = [...candidates].filter((el) => !el.hasAttribute(ATTR.brand));
    if (!todo.length) return;
    const theme = root.getAttribute(ATTR.theme);
    if (theme) root.removeAttribute(ATTR.theme);
    const brand = todo.filter((el) => CORE.isBrandSurface(getComputedStyle(el).backgroundColor, CFG.BRAND_SCAN));
    if (theme) root.setAttribute(ATTR.theme, theme);
    brand.forEach((el) => el.setAttribute(ATTR.brand, ''));
  }

  // ---------------------------------------------------------------- shadow roots

  /** Adopts Mode A colour rules into shadow roots, which app.css cannot reach. */
  const shadows = (() => {
    let sheet = null;
    const adopted = new Set(); // WeakRef<ShadowRoot>

    function getSheet() {
      if (!sheet) {
        sheet = new CSSStyleSheet();
        sheet.replaceSync(SHADOW.css);
      }
      return sheet;
    }

    /** Open roots directly; closed roots through chrome.dom where the browser has it. */
    function rootOf(el) {
      if (el.shadowRoot) return el.shadowRoot;
      try {
        return chrome.dom?.openOrClosedShadowRoot?.(el) || null;
      } catch {
        return null;
      }
    }

    function adopt(sr) {
      if (sr.adoptedStyleSheets.includes(getSheet())) return false;
      try {
        sr.adoptedStyleSheets = [...sr.adoptedStyleSheets, getSheet()];
        adopted.add(new WeakRef(sr));
        return true;
      } catch {
        return false; // e.g. Firefox refusing a sheet from the content-script compartment
      }
    }

    function releaseAll() {
      adopted.forEach((ref) => {
        const sr = ref.deref();
        if (sr) sr.adoptedStyleSheets = sr.adoptedStyleSheets.filter((x) => x !== sheet);
      });
      adopted.clear();
    }

    return { rootOf, adopt, releaseAll };
  })();

  // ---------------------------------------------------------------- user-origin CSS (C1)

  // The manifest stylesheet (author origin) applies at once; the user-origin copy
  // arrives a moment later and then wins every conflict with site !important rules.
  // Requested once per document, only when a theme is first activated here.
  let userCssRequested = false;
  function requestUserCss() {
    if (userCssRequested) return;
    userCssRequested = true;
    chrome.runtime.sendMessage({ type: CFG.MESSAGE_TYPES.injectUserCss }).catch(() => {
      userCssRequested = false; // extension reloaded; try again on the next activation
    });
  }

  // ---------------------------------------------------------------- layers

  /** Marks fixed/sticky elements so app.css can keep them opaque; finds shadow roots. */
  const layers = (() => {
    const { chunkSize, debounceMs } = CFG.LAYER_SCAN;
    const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 1));
    let active = false;
    let queue = [];
    let scheduled = false;
    let pending = [];
    let debounceTimer = 0;

    function inspect(el, newLayers) {
      if (el.nodeType !== 1 || el.localName === CFG.HOST_TAG) return;
      const sr = shadows.rootOf(el);
      if (sr && shadows.adopt(sr)) for (const inner of sr.querySelectorAll('*')) queue.push(inner);
      if (el.hasAttribute(ATTR.layer)) return;
      const cs = getComputedStyle(el);
      if (cs.position !== 'fixed' && cs.position !== 'sticky') return;
      const rect = el.getBoundingClientRect();
      const mark = CORE.shouldMarkLayer(
        {
          position: cs.position,
          pointerEvents: cs.pointerEvents,
          width: rect.width,
          height: rect.height,
          vw: window.innerWidth,
          vh: window.innerHeight,
        },
        CFG.LAYER_SCAN,
      );
      if (mark) {
        el.setAttribute(ATTR.layer, '');
        newLayers.push(el);
      }
    }

    function drain(deadline) {
      scheduled = false;
      if (!active) return;
      let n = 0;
      const newLayers = [];
      while (queue.length && n < chunkSize && (!deadline || deadline.timeRemaining() > 1 || n === 0)) {
        inspect(queue.pop(), newLayers);
        n += 1;
      }
      if (newLayers.length) markBrandBars(newLayers); // a floating bar can be a brand bar too
      if (queue.length) schedule();
    }

    function schedule() {
      if (!scheduled) {
        scheduled = true;
        idle(drain);
      }
    }

    function enqueueSubtree(node) {
      if (node.nodeType !== 1) return;
      queue.push(node);
      for (const el of node.querySelectorAll('*')) queue.push(el);
      schedule();
    }

    const observer = new MutationObserver((records) => {
      for (const r of records) for (const n of r.addedNodes) if (n.nodeType === 1) pending.push(n);
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        const batch = pending.filter((n) => n.isConnected);
        pending = [];
        if (active) markBrandBars(batch);
        batch.forEach(enqueueSubtree);
      }, debounceMs);
    });

    function start() {
      const begin = () => {
        if (!active || !document.body) return;
        markBrandBars([document.body]);
        enqueueSubtree(document.body);
        observer.observe(document.body, { childList: true, subtree: true });
      };
      if (document.body) begin();
      else document.addEventListener('DOMContentLoaded', begin, { once: true });
    }

    function stop() {
      observer.disconnect();
      clearTimeout(debounceTimer);
      queue = [];
      pending = [];
      document.querySelectorAll(`[${ATTR.layer}]`).forEach((el) => el.removeAttribute(ATTR.layer));
      document.querySelectorAll(`[${ATTR.brand}]`).forEach((el) => el.removeAttribute(ATTR.brand));
      shadows.releaseAll();
    }

    return {
      setActive(next) {
        if (next === active) return;
        active = next;
        if (active) {
          requestUserCss();
          start();
        } else stop();
      },
    };
  })();

  // ---------------------------------------------------------------- export (A1)

  /** The active theme as a file, with provenance (hostname only, never path or query). */
  function buildCurrentExport(formatId) {
    if (!effective.theme) return null;
    const tokens = EXPORT.collectTokens(readVar, CFG.REQUIRED_TOKENS);
    return EXPORT.buildExport(formatId, effective.theme, tokens, CFG.EXPORT_FORMATS, {
      mode: effective.enhanced ? 'enhanced' : 'default',
      fonts: effective.fonts ? 'on' : 'off',
      source: host,
      exportedAt: new Date().toISOString(),
      uixVersion: chrome.runtime.getManifest().version,
    });
  }

  function exportTokens(formatId) {
    const file = buildCurrentExport(formatId);
    if (!file) return { ok: false, message: t('exportNeedsTheme') };
    const url = URL.createObjectURL(new Blob([file.body], { type: file.mime }));
    const a = document.createElement('a');
    a.href = url;
    a.download = file.filename;
    a.rel = 'noopener';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    return { ok: true, message: t('exportDone', [file.filename]) };
  }

  /**
   * Copy the same content to the clipboard. The async Clipboard API needs the click's
   * user activation and can be blocked by a site's Permissions-Policy, so fall back to
   * a hidden textarea inside our own shadow root.
   */
  async function copyTokens(formatId, scratchParent) {
    const file = buildCurrentExport(formatId);
    if (!file) return { ok: false, message: t('exportNeedsTheme') };
    const label = t(CFG.EXPORT_FORMATS.find((f) => f.id === formatId).msg);
    try {
      await navigator.clipboard.writeText(file.body);
      return { ok: true, message: t('copyDone', [label]) };
    } catch {
      const area = h('textarea', { attrs: { 'aria-hidden': 'true', readonly: '' }, props: { value: file.body } });
      area.style.cssText = 'position:fixed;opacity:0;pointer-events:none;';
      scratchParent.appendChild(area);
      area.select();
      const ok = document.execCommand('copy');
      area.remove();
      return ok ? { ok: true, message: t('copyDone', [label]) } : { ok: false, message: t('copyFailed') };
    }
  }

  // ---------------------------------------------------------------- panel

  const PANEL_CSS = `
    .panel {
      all: initial;
      --p-bg: var(--uix-surface, #ffffff);
      --p-fg: var(--uix-fg, #111418);
      --p-muted: var(--uix-muted, #5b6470);
      --p-border: var(--uix-border, #d9dde3);
      --p-accent: var(--uix-accent, #1f5fd1);
      --p-accent-fg: var(--uix-accent-fg, #ffffff);
      box-sizing: border-box;
      display: flex;
      flex-direction: column;
      gap: 12px;
      width: 300px;
      max-height: min(85vh, 720px);
      overflow: auto;
      padding: 16px;
      background: var(--p-bg);
      color: var(--p-fg);
      border: 1px solid var(--p-border);
      border-radius: 12px;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.24);
      font: 14px/1.45 system-ui, -apple-system, "Segoe UI", "PingFang TC", "Noto Sans TC", sans-serif;
    }
    @media (prefers-color-scheme: dark) {
      .panel {
        --p-bg: var(--uix-surface, #1e1f22);
        --p-fg: var(--uix-fg, #e6e6e6);
        --p-muted: var(--uix-muted, #a0a4ab);
        --p-border: var(--uix-border, #34373c);
        --p-accent: var(--uix-accent, #8ab4f8);
        --p-accent-fg: var(--uix-accent-fg, #0b1220);
      }
    }
    .panel *, .panel *::before, .panel *::after { box-sizing: border-box; font: inherit; color: inherit; }
    .head { display: flex; align-items: center; justify-content: space-between; }
    .title { font-weight: 600; font-size: 15px; margin: 0; }
    .close {
      width: 28px; height: 28px; border: 0; border-radius: 6px; cursor: pointer;
      background: transparent; font-size: 18px; line-height: 1;
    }
    .close:hover { background: var(--p-border); }
    fieldset { border: 0; margin: 0; padding: 0; display: grid; gap: 2px; }
    legend { padding: 0; margin-bottom: 6px; color: var(--p-muted); font-size: 12px; }
    .opt { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 6px; cursor: pointer; }
    .opt:hover { background: color-mix(in srgb, var(--p-border) 50%, transparent); }
    input[type="radio"], input[type="checkbox"] { accent-color: var(--p-accent); margin: 0; }
    .row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .row[hidden] { display: none; }
    .group { display: grid; gap: 8px; padding-top: 12px; border-top: 1px solid var(--p-border); }
    input[type="color"] { width: 40px; height: 28px; padding: 0; border: 1px solid var(--p-border); border-radius: 6px; background: none; }
    select {
      min-width: 0; max-width: 150px; padding: 4px 6px; border-radius: 6px;
      border: 1px solid var(--p-border); background: var(--p-bg);
    }
    .ghost {
      padding: 4px 10px; border-radius: 6px; cursor: pointer;
      border: 1px solid var(--p-border); background: transparent;
    }
    .actions { display: flex; justify-content: flex-end; gap: 8px; }
    .foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .hint { color: var(--p-muted); font-size: 12px; }
    .apply {
      border: 0; border-radius: 8px; padding: 8px 16px; cursor: pointer; font-weight: 600;
      background: var(--p-accent); color: var(--p-accent-fg);
    }
    .status { min-height: 1em; font-size: 12px; color: var(--p-muted); }
    :focus-visible { outline: 2px solid var(--p-accent); outline-offset: 2px; }
  `;

  /** Minimal element factory: properties and attributes only, text via textContent. */
  function h(tag, { attrs = {}, props = {}, text } = {}, children = []) {
    const el = document.createElement(tag);
    Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
    Object.assign(el, props);
    if (text !== undefined) el.textContent = text;
    children.forEach((c) => el.appendChild(c));
    return el;
  }

  const option = (value, label) => h('option', { props: { value }, text: label });

  function adoptStyles(shadow, cssText) {
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(cssText);
      shadow.adoptedStyleSheets = [sheet];
    } catch {
      // Firefox can refuse sheets constructed in the content-script compartment.
      shadow.appendChild(h('style', { text: cssText }));
    }
  }

  const panel = (() => {
    let hostEl = null;
    let refs = null;
    let lastFocus = null;

    const isVisible = () => Boolean(hostEl) && hostEl.style.display !== 'none';

    function setDisplay(value) {
      hostEl.style.setProperty('display', value, 'important');
    }

    function build() {
      hostEl = document.createElement(CFG.HOST_TAG);
      const hostStyle = {
        position: 'fixed',
        right: '16px',
        bottom: '16px',
        'z-index': '2147483647',
        margin: '0',
        padding: '0',
      };
      Object.entries(hostStyle).forEach(([k, v]) => hostEl.style.setProperty(k, v, 'important'));
      setDisplay('none'); // default: hidden until U

      const shadow = hostEl.attachShadow({ mode: 'closed' });
      adoptStyles(shadow, PANEL_CSS);

      const closeBtn = h('button', { attrs: { type: 'button', class: 'close', 'aria-label': t('closePanel') }, text: '×' });
      const options = [{ id: '', label: t('optionNone') }, ...CFG.THEMES.map((x) => ({ id: x.id, label: t(x.msg) }))].map(
        (x) =>
          h('label', { attrs: { class: 'opt' } }, [
            h('input', { props: { type: 'radio', name: 'theme', value: x.id } }),
            h('span', { text: x.label }),
          ]),
      );

      const accentInput = h('input', { props: { type: 'color', name: 'accent' } });
      const accentRow = h('label', { attrs: { class: 'row' } }, [h('span', { text: t('accentLabel') }), accentInput]);
      const enhancedInput = h('input', { props: { type: 'checkbox', name: 'enhanced' } });
      const fontsInput = h('input', { props: { type: 'checkbox', name: 'fonts' } });
      const followInput = h('input', { props: { type: 'checkbox', name: 'followSystem' } });
      const darkSelect = h(
        'select',
        { props: { name: 'darkTheme' }, attrs: { 'aria-label': t('followSystemLabel') } },
        CFG.THEMES.map((x) => option(x.id, t(x.msg))),
      );
      const excludeInput = h('input', { props: { type: 'checkbox', name: 'exclude', disabled: !host } });
      const formatSelect = h(
        'select',
        { props: { name: 'format' }, attrs: { 'aria-label': t('exportLabel') } },
        CFG.EXPORT_FORMATS.map((f) => option(f.id, t(f.msg))),
      );
      const exportBtn = h('button', { attrs: { type: 'button', class: 'ghost' }, text: t('exportButton') });
      const copyBtn = h('button', { attrs: { type: 'button', class: 'ghost' }, text: t('copyButton') });
      const status = h('div', { attrs: { class: 'status', role: 'status', 'aria-live': 'polite' } });

      const form = h('form', { attrs: { class: 'panel', 'aria-label': t('panelTitle') } }, [
        h('div', { attrs: { class: 'head' } }, [h('p', { attrs: { class: 'title' }, text: t('panelTitle') }), closeBtn]),
        h('fieldset', {}, [h('legend', { text: t('legendTheme') }), ...options]),
        accentRow,
        h('div', { attrs: { class: 'group' } }, [
          h('label', { attrs: { class: 'row' } }, [h('span', { text: t('enhancedLabel') }), enhancedInput]),
          h('label', { attrs: { class: 'row' } }, [h('span', { text: t('fontsLabel') }), fontsInput]),
          h('div', { attrs: { class: 'row' } }, [
            h('label', { attrs: { class: 'row' } }, [followInput, h('span', { text: t('followSystemLabel') })]),
            darkSelect,
          ]),
          h('label', { attrs: { class: 'row' } }, [
            h('span', { text: t('excludeSiteLabel', [host || '—']) }),
            excludeInput,
          ]),
        ]),
        h('div', { attrs: { class: 'group' } }, [
          h('div', { attrs: { class: 'row' } }, [h('span', { text: t('exportLabel') }), formatSelect]),
          h('div', { attrs: { class: 'actions' } }, [exportBtn, copyBtn]),
        ]),
        h('div', { attrs: { class: 'foot' } }, [
          h('span', { attrs: { class: 'hint' }, text: t('hintKeys') }),
          h('button', { attrs: { type: 'submit', class: 'apply' }, text: t('applyButton') }),
        ]),
        status,
      ]);
      shadow.appendChild(form);

      closeBtn.addEventListener('click', close);
      form.addEventListener('change', updateVisibility);
      form.addEventListener('submit', onSubmit);
      copyBtn.addEventListener('click', async () => {
        refs.status.textContent = (await copyTokens(formatSelect.value, shadow)).message;
      });
      exportBtn.addEventListener('click', () => {
        refs.status.textContent = exportTokens(formatSelect.value).message;
      });

      refs = { form, accentInput, accentRow, enhancedInput, fontsInput, followInput, darkSelect, excludeInput, status };
      root.appendChild(hostEl); // outside <body>: survives body swaps, not hit by body-scoped rules
    }

    function updateVisibility() {
      const checked = refs.form.querySelector('input[name="theme"]:checked');
      refs.accentRow.hidden = !checked || checked.value !== CFG.CUSTOM_THEME_ID;
      refs.darkSelect.disabled = !refs.followInput.checked;
      // Enhanced mode always changes fonts; show that instead of a misleading unchecked box,
      // and restore the saved choice when enhanced is switched off again.
      if (!refs.enhancedInput.checked && refs.fontsInput.disabled) refs.fontsInput.checked = settings.fonts;
      refs.fontsInput.disabled = refs.enhancedInput.checked;
      if (refs.enhancedInput.checked) refs.fontsInput.checked = true;
    }

    function readForm() {
      const checked = refs.form.querySelector('input[name="theme"]:checked');
      const others = settings.excludedHosts.filter((x) => x !== host);
      return sanitize({
        theme: checked ? checked.value : null,
        enhanced: refs.enhancedInput.checked,
        fonts: refs.fontsInput.checked && !refs.enhancedInput.checked,
        accent: refs.accentInput.value,
        followSystem: refs.followInput.checked,
        darkTheme: refs.darkSelect.value,
        excludedHosts: refs.excludeInput.checked && host ? [...others, host] : others,
      });
    }

    function sync() {
      if (!refs) return;
      refs.form.querySelectorAll('input[name="theme"]').forEach((r) => {
        r.checked = r.value === (settings.theme || '');
      });
      refs.enhancedInput.checked = settings.enhanced;
      refs.fontsInput.checked = settings.fonts;
      refs.accentInput.value = settings.accent;
      refs.followInput.checked = settings.followSystem;
      refs.darkSelect.value = settings.darkTheme;
      refs.excludeInput.checked = CORE.isHostExcluded(host, settings.excludedHosts);
      updateVisibility();
    }

    function statusFor(next) {
      if (effective.theme) return t('statusApplied', [themeLabel(effective.theme)]);
      if (next.theme && CORE.isHostExcluded(host, next.excludedHosts)) return t('statusExcluded');
      return t('statusOff');
    }

    async function onSubmit(e) {
      e.preventDefault();
      const next = readForm();
      settings = next;
      render(); // apply now; storage.onChanged updates the other tabs
      try {
        await saveSettings(next);
        refs.status.textContent = statusFor(next);
      } catch {
        refs.status.textContent = t('statusSaveFailed');
      }
    }

    function open() {
      if (!hostEl) build();
      if (!hostEl.isConnected) root.appendChild(hostEl);
      sync();
      refs.status.textContent = '';
      lastFocus = document.activeElement;
      setDisplay('block');
      const target = refs.form.querySelector('input[name="theme"]:checked');
      if (target) target.focus({ preventScroll: true });
    }

    function close() {
      if (!hostEl) return;
      setDisplay('none');
      if (lastFocus && lastFocus.isConnected && typeof lastFocus.focus === 'function') {
        lastFocus.focus({ preventScroll: true });
      }
      lastFocus = null;
    }

    return { open, close, sync, isVisible };
  })();

  // ---------------------------------------------------------------- keys

  function deepActiveElement() {
    let el = document.activeElement;
    while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
    return el;
  }

  function onKeyDown(evt) {
    const origin = typeof evt.composedPath === 'function' ? evt.composedPath()[0] : evt.target;
    const editable = CORE.isEditableElement(origin) || CORE.isEditableElement(deepActiveElement());
    const action = CORE.resolveKeyAction(evt, { visible: panel.isVisible(), editable, keys: CFG.KEYS });
    if (!action) return;
    // Only swallow the key when we actually act on it.
    evt.preventDefault();
    evt.stopImmediatePropagation();
    if (action === 'open') panel.open();
    else panel.close();
  }

  // ---------------------------------------------------------------- boot

  if (isTopFrame) {
    window.addEventListener('keydown', onKeyDown, true);
    // C3: Alt+Shift+U from chrome.commands, relayed by the background worker. Works
    // even while keyboard focus is inside a cross-origin iframe. Only our own
    // extension can send runtime messages; the sender id is checked anyway.
    chrome.runtime.onMessage.addListener((msg, sender) => {
      if (sender.id !== chrome.runtime.id || !msg || msg.type !== CFG.MESSAGE_TYPES.togglePanel) return;
      if (panel.isVisible()) panel.close();
      else panel.open();
    });
  }

  darkQuery.addEventListener('change', render); // D2: follow OS light/dark live

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync' || !changes[STORAGE_KEY]) return;
    settings = sanitize(changes[STORAGE_KEY].newValue);
    render();
  });

  loadSettings().then((loaded) => {
    settings = loaded;
    render();
  });
})();
