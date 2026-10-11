/**
 * Pure logic, no chrome.* and no global DOM access, so it runs under node:test.
 * Anything that depends on configuration takes it as an argument.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.UIX_CORE = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const HEX = /^#[0-9a-f]{6}$/i;
  const isHexColor = (v) => typeof v === 'string' && HEX.test(v);

  function relativeLuminance(hex) {
    const [r, g, b] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  function contrastRatio(a, b) {
    const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  }

  const readableTextOn = (hex) =>
    contrastRatio(hex, '#000000') >= contrastRatio(hex, '#ffffff') ? '#000000' : '#ffffff';

  const HOSTNAME = /^(?=.{1,253}$)[a-z0-9-]+(\.[a-z0-9-]+)*$/;

  function normalizeHost(v) {
    if (typeof v !== 'string') return null;
    const h = v.trim().toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
    return HOSTNAME.test(h) ? h : null;
  }

  /** Valid, de-duplicated hostnames; falls back to defaults when absent. */
  function sanitizeHostList(raw, { defaults, max }) {
    if (!Array.isArray(raw)) return defaults.slice(0, max);
    const out = [];
    for (const v of raw) {
      const h = normalizeHost(v);
      if (h && !out.includes(h)) out.push(h);
      if (out.length >= max) break;
    }
    return out;
  }

  /** Storage is untrusted input: whitelist every field, own properties only. */
  function sanitizeSettings(raw, { themeIds, defaults, maxHosts }) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const own = (k) => (Object.prototype.hasOwnProperty.call(src, k) ? src[k] : undefined);
    const theme = own('theme');
    const accent = own('accent');
    const darkTheme = own('darkTheme');
    return {
      theme: themeIds.includes(theme) ? theme : null,
      enhanced: own('enhanced') === true,
      fonts: own('fonts') === true,
      accent: isHexColor(accent) ? accent.toLowerCase() : defaults.accent,
      followSystem: own('followSystem') === true,
      darkTheme: themeIds.includes(darkTheme) ? darkTheme : defaults.darkTheme,
      excludedHosts: sanitizeHostList(own('excludedHosts'), {
        defaults: defaults.excludedHosts,
        max: maxHosts,
      }),
    };
  }

  /** Exact host or any subdomain of a listed host. */
  function isHostExcluded(host, list) {
    const h = normalizeHost(host);
    return Boolean(h) && list.some((x) => h === x || h.endsWith(`.${x}`));
  }

  /** Top-level site host; iframes use location.ancestorOrigins when available. */
  function pickTopHost(ownHost, ancestorOrigins) {
    const last = ancestorOrigins && ancestorOrigins.length ? ancestorOrigins[ancestorOrigins.length - 1] : null;
    if (last) {
      try {
        return new URL(last).hostname;
      } catch {
        /* opaque origin ("null") — fall through */
      }
    }
    return ownHost;
  }

  /** Stored settings + environment → what this page should actually render. */
  function resolveEffective(settings, { prefersDark, host }) {
    // "Original site by day, Dark by night" is valid: theme may be null here.
    const theme = settings.followSystem && prefersDark ? settings.darkTheme : settings.theme;
    if (!theme || isHostExcluded(host, settings.excludedHosts)) {
      return { theme: null, enhanced: false, fonts: false, accent: settings.accent };
    }
    // Enhanced mode already changes layout, so it always includes fonts.
    return { theme, enhanced: settings.enhanced, fonts: settings.fonts || settings.enhanced, accent: settings.accent };
  }

  const NON_TEXT_INPUTS = new Set([
    'button', 'submit', 'reset', 'checkbox', 'radio', 'range', 'color', 'file', 'image', 'hidden',
  ]);
  const TEXT_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton']);

  function isEditableElement(el) {
    if (!el || typeof el !== 'object') return false;
    if (el.isContentEditable) return true;
    const tag = String(el.tagName || '').toUpperCase();
    if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (tag === 'INPUT') return !NON_TEXT_INPUTS.has(String(el.type || 'text').toLowerCase());
    const role = typeof el.getAttribute === 'function' ? el.getAttribute('role') : null;
    return TEXT_ROLES.has(String(role || '').toLowerCase());
  }

  /** @returns {'open'|'close'|null} */
  function resolveKeyAction(evt, { visible, editable, keys }) {
    if (!evt) return null;
    if (evt.isComposing || evt.keyCode === 229) return null; // IME (e.g. 注音) in progress
    if (evt.ctrlKey || evt.metaKey || evt.altKey) return null; // leave browser/site shortcuts alone
    if (evt.repeat || editable) return null;
    if (!visible && keys.open.includes(evt.code)) return 'open';
    if (visible && keys.close.includes(evt.code)) return 'close';
    return null;
  }

  /** Custom-theme overrides written as inline custom properties on <html>. */
  function customProperties(settings, { CUSTOM_THEME_ID, MIN_CONTRAST, MIN_NON_TEXT_CONTRAST }, baseBg) {
    if (settings.theme !== CUSTOM_THEME_ID) return {};
    const props = {
      '--uix-accent': settings.accent,
      '--uix-accent-fg': readableTextOn(settings.accent),
      '--uix-focus': settings.accent,
    };
    // Only recolour links when the accent is still readable as text.
    if (isHexColor(baseBg) && contrastRatio(settings.accent, baseBg) >= MIN_CONTRAST) {
      props['--uix-link'] = settings.accent;
    }
    // Brand bars take the accent only if white icons stay visible on it.
    if (contrastRatio(settings.accent, '#ffffff') >= MIN_NON_TEXT_CONTRAST) {
      props['--uix-brand-bg'] = settings.accent;
      props['--uix-brand-fg'] = readableTextOn(settings.accent);
    }
    return props;
  }

  const CUSTOM_PROPS = ['--uix-accent', '--uix-accent-fg', '--uix-focus', '--uix-link', '--uix-brand-bg', '--uix-brand-fg'];

  /**
   * Reflect settings onto the root element. Returns true when a theme is active.
   * `readBaseBg()` returns the active theme's --uix-bg; it is called after the
   * theme attribute is set so the stylesheet stays the only source of colours.
   */
  function applyThemeToRoot(rootEl, settings, cfg, readBaseBg) {
    const { ATTR } = cfg;
    const toggle = (name, on) => (on ? rootEl.setAttribute(name, '') : rootEl.removeAttribute(name));
    if (settings.theme) rootEl.setAttribute(ATTR.theme, settings.theme);
    else rootEl.removeAttribute(ATTR.theme);
    toggle(ATTR.enhanced, Boolean(settings.theme && settings.enhanced));
    toggle(ATTR.fonts, Boolean(settings.theme && settings.fonts));
    const isCustom = settings.theme === cfg.CUSTOM_THEME_ID;
    const props = isCustom ? customProperties(settings, cfg, readBaseBg ? readBaseBg() : null) : {};
    CUSTOM_PROPS.forEach((p) => {
      if (p in props) rootEl.style.setProperty(p, props[p]);
      else rootEl.style.removeProperty(p);
    });
    return Boolean(settings.theme);
  }

  /** True when the page has not tampered with what applyThemeToRoot wrote. */
  function isRootInSync(rootEl, settings, cfg) {
    const { ATTR, CUSTOM_THEME_ID } = cfg;
    if (!settings.theme) return !rootEl.hasAttribute(ATTR.theme);
    if (rootEl.getAttribute(ATTR.theme) !== settings.theme) return false;
    if (rootEl.hasAttribute(ATTR.enhanced) !== Boolean(settings.enhanced)) return false;
    if (rootEl.hasAttribute(ATTR.fonts) !== Boolean(settings.fonts)) return false;
    if (settings.theme === CUSTOM_THEME_ID) {
      return rootEl.style.getPropertyValue('--uix-accent') === settings.accent;
    }
    return true;
  }

  /**
   * Fixed/sticky elements (sticky headers, cookie bars, chat widgets) float over
   * content, so they must keep an opaque background after the colour reset.
   * Near-full-viewport overlays and click-through layers are skipped: making
   * those opaque would hide the page.
   */
  function shouldMarkLayer({ position, pointerEvents, width, height, vw, vh }, { maxViewportCoverage }) {
    if (position !== 'fixed' && position !== 'sticky') return false;
    if (pointerEvents === 'none') return false;
    if (!(width > 0 && height > 0)) return false;
    const coverage = (Math.min(width, vw) * Math.min(height, vh)) / (vw * vh);
    return coverage < maxViewportCoverage;
  }

  /** Parse a computed rgb()/rgba() colour. Other syntaxes (oklch, color()) → null. */
  function parseRgb(str) {
    const m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/i.exec(String(str).trim());
    if (!m) return null;
    let a = m[4] === undefined ? 1 : parseFloat(m[4]);
    if (m[4] && m[4].endsWith('%')) a /= 100;
    return { r: +m[1], g: +m[2], b: +m[3], a };
  }

  const toHex = ({ r, g, b }) => `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;

  /** Original background of site chrome: opaque and dark/saturated enough to carry white icons. */
  function isBrandSurface(computedBg, { maxLuminance, minAlpha }) {
    const c = parseRgb(computedBg);
    if (!c || c.a < minAlpha) return false;
    return relativeLuminance(toHex(c)) <= maxLuminance;
  }

  return {
    parseRgb,
    isBrandSurface,
    isHexColor,
    relativeLuminance,
    contrastRatio,
    readableTextOn,
    normalizeHost,
    sanitizeHostList,
    sanitizeSettings,
    isHostExcluded,
    pickTopHost,
    resolveEffective,
    isEditableElement,
    resolveKeyAction,
    customProperties,
    applyThemeToRoot,
    isRootInSync,
    shouldMarkLayer,
  };
});
