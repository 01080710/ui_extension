'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const CFG = require('../src/config.js');
const CORE = require('../src/core.js');
const { fakeRoot } = require('./helpers.js');

const themeIds = CFG.THEMES.map((t) => t.id);
const opts = { themeIds, defaults: CFG.DEFAULT_SETTINGS, maxHosts: CFG.MAX_EXCLUDED_HOSTS };
const [firstTheme] = themeIds;
const nonCustom = themeIds.find((id) => id !== CFG.CUSTOM_THEME_ID);
const [openKey] = CFG.KEYS.open;
const [closeKey] = CFG.KEYS.close;

test('r5 spec: U opens and I closes by default', () => {
  assert.deepEqual(CFG.KEYS, { open: ['KeyU'], close: ['KeyI'] });
});

test('ten themes, unique ids, custom theme registered', () => {
  assert.equal(themeIds.length, 10);
  assert.equal(new Set(themeIds).size, themeIds.length);
  assert.ok(themeIds.includes(CFG.CUSTOM_THEME_ID));
});

test('config is deeply frozen', () => {
  assert.ok(Object.isFrozen(CFG) && Object.isFrozen(CFG.THEMES[0]) && Object.isFrozen(CFG.KEYS.open));
});

test('sanitizeSettings whitelists untrusted storage', () => {
  assert.deepEqual(CORE.sanitizeSettings(undefined, opts), { ...CFG.DEFAULT_SETTINGS });
  assert.deepEqual(CORE.sanitizeSettings('x', opts), { ...CFG.DEFAULT_SETTINGS });
  const hostile = {
    theme: '"]{}</style><script>',
    enhanced: 'true',
    accent: 'red;background:url(//evil)',
    __proto__: { theme: firstTheme },
  };
  assert.deepEqual(CORE.sanitizeSettings(hostile, opts), {
    ...CFG.DEFAULT_SETTINGS,
    theme: null, // inherited (prototype) values are ignored
  });
  const ok = CORE.sanitizeSettings(
    { theme: firstTheme, enhanced: true, fonts: true, accent: '#ABCDEF', followSystem: true, darkTheme: nonCustom, excludedHosts: [] },
    opts,
  );
  assert.deepEqual(ok, {
    theme: firstTheme,
    enhanced: true,
    fonts: true,
    accent: '#abcdef',
    followSystem: true,
    darkTheme: nonCustom,
    excludedHosts: [],
  });
  assert.equal(CORE.sanitizeSettings({ darkTheme: 'nope' }, opts).darkTheme, CFG.DEFAULT_SETTINGS.darkTheme);
});

test('contrast helpers', () => {
  assert.equal(CORE.contrastRatio('#000000', '#ffffff').toFixed(1), '21.0');
  assert.equal(CORE.contrastRatio('#777777', '#777777'), 1);
  assert.equal(CORE.readableTextOn('#ffff00'), '#000000');
  assert.equal(CORE.readableTextOn('#0b4f9c'), '#ffffff');
  assert.equal(CORE.isHexColor('#12345'), false);
  assert.equal(CORE.isHexColor(null), false);
});

test('isEditableElement', () => {
  const el = (tagName, extra = {}) => ({ tagName, getAttribute: (k) => extra[k] ?? null, ...extra });
  assert.equal(CORE.isEditableElement(el('INPUT', { type: 'text' })), true);
  assert.equal(CORE.isEditableElement(el('INPUT', { type: 'search' })), true);
  assert.equal(CORE.isEditableElement(el('INPUT', { type: 'checkbox' })), false);
  assert.equal(CORE.isEditableElement(el('TEXTAREA')), true);
  assert.equal(CORE.isEditableElement(el('SELECT')), true);
  assert.equal(CORE.isEditableElement(el('DIV', { isContentEditable: true })), true);
  assert.equal(CORE.isEditableElement(el('DIV', { role: 'textbox' })), true);
  assert.equal(CORE.isEditableElement(el('BUTTON')), false);
  assert.equal(CORE.isEditableElement(null), false);
});

test('resolveKeyAction', () => {
  const base = { visible: false, editable: false, keys: CFG.KEYS };
  const key = (code, extra = {}) => ({ code, ...extra });
  assert.equal(CORE.resolveKeyAction(key(openKey), base), 'open');
  assert.equal(CORE.resolveKeyAction(key(closeKey), { ...base, visible: true }), 'close');
  // no-ops: already in that state
  assert.equal(CORE.resolveKeyAction(key(openKey), { ...base, visible: true }), null);
  assert.equal(CORE.resolveKeyAction(key(closeKey), base), null);
  // typing, IME, modifiers, auto-repeat
  assert.equal(CORE.resolveKeyAction(key(openKey), { ...base, editable: true }), null);
  assert.equal(CORE.resolveKeyAction(key(openKey, { isComposing: true }), base), null);
  assert.equal(CORE.resolveKeyAction(key(openKey, { keyCode: 229 }), base), null);
  ['ctrlKey', 'metaKey', 'altKey', 'repeat'].forEach((m) =>
    assert.equal(CORE.resolveKeyAction(key(openKey, { [m]: true }), base), null, m),
  );
  // keys are injectable, not hard-coded
  const custom = { ...base, keys: { open: ['KeyO'], close: ['KeyP'] } };
  assert.equal(CORE.resolveKeyAction(key('KeyO'), custom), 'open');
  assert.equal(CORE.resolveKeyAction(key(openKey), custom), null);
});

test('applyThemeToRoot: set, enhance, clear', () => {
  const root = fakeRoot();
  const on = CORE.applyThemeToRoot(root, { theme: nonCustom, enhanced: true, accent: '#123456' }, CFG);
  assert.equal(on, true);
  assert.equal(root.getAttribute(CFG.ATTR.theme), nonCustom);
  assert.equal(root.hasAttribute(CFG.ATTR.enhanced), true);
  assert.equal(root._props.size, 0, 'non-custom themes write no inline properties');

  const off = CORE.applyThemeToRoot(root, { ...CFG.DEFAULT_SETTINGS }, CFG);
  assert.equal(off, false);
  assert.equal(root._attrs.size, 0);
});

test('applyThemeToRoot: custom accent and link contrast guard', () => {
  const root = fakeRoot();
  const white = '#ffffff';
  const dark = { theme: CFG.CUSTOM_THEME_ID, enhanced: false, accent: '#0b4f9c' };
  CORE.applyThemeToRoot(root, dark, CFG, () => white);
  assert.equal(root.style.getPropertyValue('--uix-accent'), dark.accent);
  assert.equal(root.style.getPropertyValue('--uix-accent-fg'), CORE.readableTextOn(dark.accent));
  assert.equal(root.style.getPropertyValue('--uix-link'), dark.accent);

  const pale = { ...dark, accent: '#ffe066' }; // unreadable as link text on white
  CORE.applyThemeToRoot(root, pale, CFG, () => white);
  assert.equal(root.style.getPropertyValue('--uix-accent'), pale.accent);
  assert.equal(root.style.getPropertyValue('--uix-link'), '');

  CORE.applyThemeToRoot(root, { ...pale, theme: nonCustom }, CFG);
  assert.equal(root._props.size, 0, 'switching away clears inline properties');
});

test('isRootInSync detects page tampering', () => {
  const root = fakeRoot();
  const s = { theme: CFG.CUSTOM_THEME_ID, enhanced: true, accent: '#0b4f9c' };
  CORE.applyThemeToRoot(root, s, CFG, () => '#ffffff');
  assert.equal(CORE.isRootInSync(root, s, CFG), true);
  root.removeAttribute(CFG.ATTR.theme);
  assert.equal(CORE.isRootInSync(root, s, CFG), false);
  CORE.applyThemeToRoot(root, s, CFG, () => '#ffffff');
  root.style.removeProperty('--uix-accent');
  assert.equal(CORE.isRootInSync(root, s, CFG), false);
  assert.equal(CORE.isRootInSync(fakeRoot(), { ...CFG.DEFAULT_SETTINGS }, CFG), true);
});

test('shouldMarkLayer', () => {
  const vp = { vw: 1000, vh: 800 };
  const cfg = CFG.LAYER_SCAN;
  const mark = (o) => CORE.shouldMarkLayer({ pointerEvents: 'auto', ...vp, ...o }, cfg);
  assert.equal(mark({ position: 'sticky', width: 1000, height: 64 }), true); // sticky header
  assert.equal(mark({ position: 'fixed', width: 360, height: 480 }), true); // chat widget
  assert.equal(mark({ position: 'static', width: 1000, height: 64 }), false);
  assert.equal(mark({ position: 'absolute', width: 300, height: 300 }), false);
  assert.equal(mark({ position: 'fixed', width: 1000, height: 800 }), false); // full-screen overlay
  assert.equal(mark({ position: 'fixed', width: 0, height: 0 }), false);
  assert.equal(mark({ position: 'fixed', width: 300, height: 60, pointerEvents: 'none' }), false);
});

test('fonts are opt-in in Mode A and implied by Mode B', () => {
  const base = { ...CFG.DEFAULT_SETTINGS, theme: nonCustom, excludedHosts: [] };
  const env = { prefersDark: false, host: 'a.com' };
  assert.equal(CORE.resolveEffective(base, env).fonts, false);
  assert.equal(CORE.resolveEffective({ ...base, fonts: true }, env).fonts, true);
  assert.equal(CORE.resolveEffective({ ...base, enhanced: true }, env).fonts, true);
  const root = fakeRoot();
  CORE.applyThemeToRoot(root, CORE.resolveEffective({ ...base, fonts: true }, env), CFG);
  assert.equal(root.hasAttribute(CFG.ATTR.fonts), true);
  assert.equal(CORE.isRootInSync(root, CORE.resolveEffective(base, env), CFG), false);
  CORE.applyThemeToRoot(root, CORE.resolveEffective({ ...base, theme: null }, env), CFG);
  assert.equal(root._attrs.size, 0);
});

test('parseRgb and isBrandSurface', () => {
  assert.deepEqual(CORE.parseRgb('rgb(47, 85, 180)'), { r: 47, g: 85, b: 180, a: 1 });
  assert.deepEqual(CORE.parseRgb('rgba(0, 0, 0, 0.5)'), { r: 0, g: 0, b: 0, a: 0.5 });
  assert.deepEqual(CORE.parseRgb('rgb(10 20 30 / 40%)'), { r: 10, g: 20, b: 30, a: 0.4 });
  assert.equal(CORE.parseRgb('oklch(0.5 0.1 200)'), null);
  const b = CFG.BRAND_SCAN;
  assert.equal(CORE.isBrandSurface('rgb(47, 85, 180)', b), true, 'blue nav bar');
  assert.equal(CORE.isBrandSurface('rgb(34, 34, 34)', b), true, 'dark header');
  assert.equal(CORE.isBrandSurface('rgb(255, 255, 255)', b), false, 'white header');
  assert.equal(CORE.isBrandSurface('rgb(250, 212, 0)', b), false, 'yellow bar carries dark content');
  assert.equal(CORE.isBrandSurface('rgba(0, 0, 0, 0)', b), false, 'transparent');
  assert.equal(CORE.isBrandSurface('rgba(0, 0, 0, 0.3)', b), false, 'scrim');
});

test('custom accent drives brand surface only when white stays visible on it', () => {
  const root = fakeRoot();
  const s = { theme: CFG.CUSTOM_THEME_ID, enhanced: false, fonts: false, accent: '#0b4f9c' };
  CORE.applyThemeToRoot(root, s, CFG, () => '#ffffff');
  assert.equal(root.style.getPropertyValue('--uix-brand-bg'), s.accent);
  assert.ok(CORE.contrastRatio(root.style.getPropertyValue('--uix-brand-fg'), s.accent) >= CFG.MIN_CONTRAST);
  CORE.applyThemeToRoot(root, { ...s, accent: '#ffe066' }, CFG, () => '#ffffff');
  assert.equal(root.style.getPropertyValue('--uix-brand-bg'), '', 'pale accent keeps the theme brand surface');
});
