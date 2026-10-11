'use strict';

// End-to-end on a local fixture: real keyboard, real storage, real CSS.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { CFG, launch, attachExtensionWorld, setSettings, waitForTheme, serveDir } = require('./harness.js');

const themeIds = CFG.THEMES.map((t) => t.id);
const darkIdx = themeIds.indexOf('dark');
const base = { ...CFG.DEFAULT_SETTINGS, excludedHosts: [] };

let browser;
let server;
let page;
let world;

const hostDisplay = () =>
  page.evaluate((tag) => document.querySelector(tag)?.style.display ?? 'absent', CFG.HOST_TAG);
const tokenOf = (name) =>
  page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);
const colorOf = (sel) => page.evaluate((s) => getComputedStyle(document.querySelector(s)).color, sel);
const hexToRgb = (hex) => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(', ')})`;

test.before(async () => {
  ({ server, origin: test.origin } = await serveDir(__dirname));
  browser = await launch();
  page = await browser.context.newPage();
  world = await attachExtensionWorld(page);
  await page.goto(`${test.origin}/fixture.html`);
  await setSettings(world, base);
  await waitForTheme(page, null);
});

test.after(async () => {
  await browser?.close();
  server?.close();
});

test('panel is hidden by default; U opens, I closes', async () => {
  assert.equal(await hostDisplay(), 'absent'); // built lazily
  await page.locator('#para').click();
  await page.keyboard.press('u');
  assert.equal(await hostDisplay(), 'block');
  await page.keyboard.press('i');
  assert.equal(await hostDisplay(), 'none');
});

test('typing U/I in a text field never toggles the panel', async () => {
  await page.locator('#text').click();
  await page.keyboard.type('ui UI');
  assert.equal(await hostDisplay(), 'none');
  assert.equal(await page.locator('#text').inputValue(), 'ui UI');
});

test('keyboard-only flow: U → arrows → Enter applies the theme', async () => {
  await page.locator('#para').click();
  await page.keyboard.press('u');
  for (let i = 0; i <= darkIdx; i += 1) await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await waitForTheme(page, 'dark');
  await page.keyboard.press('i');
  assert.equal(await hostDisplay(), 'none');
});

test('Mode A colours come from tokens, including over site !important', async () => {
  const fg = hexToRgb(await tokenOf('--uix-fg'));
  assert.equal(await colorOf('#para'), fg);
  assert.equal(await colorOf('#forced'), fg);
  assert.equal(await colorOf('#link'), hexToRgb(await tokenOf('--uix-link')));
  assert.equal(await colorOf('#submit'), hexToRgb(await tokenOf('--uix-accent-fg')));
});

const fontOf = (sel) => page.evaluate((s) => getComputedStyle(document.querySelector(s)).fontFamily, sel);

test('C1: user-origin CSS beats site !important of any specificity, inline included', async () => {
  const fg = hexToRgb(await tokenOf('--uix-fg'));
  await page.waitForFunction(
    (want) => ['#hard', '#inlineimp'].every((s) => getComputedStyle(document.querySelector(s)).color === want),
    fg,
    { timeout: 5000 },
  );
  assert.equal(await colorOf('#hard'), fg);
  assert.equal(await colorOf('#inlineimp'), fg);
});

test('Mode A keeps the site fonts unless fonts are switched on', async () => {
  assert.match(await fontOf('#para'), /Georgia/, 'default: colours only');
  await setSettings(world, { ...base, theme: 'dark', fonts: true });
  await page.waitForFunction((a) => document.documentElement.hasAttribute(a), CFG.ATTR.fonts);
  assert.match(await fontOf('#para'), /system-ui/, 'opt-in: theme font');
  assert.equal((await fontOf('#icon')).replace(/"/g, ''), 'FixtureIcons', 'icon fonts are never replaced');
  await setSettings(world, { ...base, theme: 'dark' });
  await page.waitForFunction((a) => !document.documentElement.hasAttribute(a), CFG.ATTR.fonts);
});

test('dark site chrome becomes a brand surface instead of being cleared', async () => {
  await page.waitForFunction((a) => document.querySelector('#hdr').hasAttribute(a), CFG.ATTR.brand);
  const bg = await page.evaluate(() => getComputedStyle(document.querySelector('#hdr')).backgroundColor);
  assert.equal(bg, hexToRgb(await tokenOf('--uix-brand-bg')));
  const light = await page.evaluate((a) => document.querySelector('#card').hasAttribute(a), CFG.ATTR.brand);
  assert.equal(light, false, 'light containers are reset as usual');
});

test('Mode A colours reach into shadow roots', async () => {
  const inner = () => page.evaluate(() => getComputedStyle(document.querySelector('#widget').shadowRoot.querySelector('#inner')).color);
  await page.waitForFunction(() => {
    const p = document.querySelector('#widget').shadowRoot.querySelector('#inner');
    return getComputedStyle(p).color !== 'rgb(204, 0, 0)';
  });
  assert.equal(await inner(), hexToRgb(await tokenOf('--uix-fg')));
});

test('fixed/sticky layers are marked, click-through overlays are not', async () => {
  await page.waitForFunction((a) => document.querySelector('#chat').hasAttribute(a), CFG.ATTR.layer);
  const marked = await page.evaluate(
    (a) => ['#hdr', '#chat', '#overlay'].map((s) => document.querySelector(s).hasAttribute(a)),
    CFG.ATTR.layer,
  );
  assert.deepEqual(marked, [true, true, false]);
});

test('A1: export downloads a DTCG file for the active theme', async () => {
  await page.locator('#para').click();
  await page.keyboard.press('u');
  // focus order from the checked radio: enhanced → fonts → follow → exclude → format → export
  for (let i = 0; i < 6; i += 1) await page.keyboard.press('Tab');
  const [download] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('Enter')]);
  assert.equal(download.suggestedFilename(), 'uix-dark.tokens.json');
  const body = JSON.parse(await require('node:fs/promises').readFile(await download.path(), 'utf8'));
  assert.equal(body.color.bg.$value.hex, await tokenOf('--uix-bg'));
  const meta = body.$extensions['dev.uix.export'];
  assert.equal(meta.theme, 'dark');
  assert.equal(meta.mode, 'default');
  assert.equal(meta.source, new URL(test.origin).hostname, 'hostname only');
  assert.match(meta.exportedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(meta.uixVersion, /^\d+\.\d+/);
  await page.keyboard.press('i');
});

test('A1: copy puts the same content on the clipboard', async () => {
  await browser.context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: test.origin });
  await page.evaluate(() => navigator.clipboard.writeText(''));
  await page.locator('#para').click();
  await page.keyboard.press('u');
  // …format → download → copy
  for (let i = 0; i < 7; i += 1) await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await page.waitForFunction(async () => (await navigator.clipboard.readText()).length > 0);
  const text = await page.evaluate(() => navigator.clipboard.readText());
  const body = JSON.parse(text);
  assert.equal(body.color.bg.$value.hex, await tokenOf('--uix-bg'));
  assert.equal(body.$extensions['dev.uix.export'].theme, 'dark');
  await page.keyboard.press('i');
});

test('Mode B toggles via the enhanced attribute', async () => {
  await setSettings(world, { ...base, theme: 'material', enhanced: true });
  await waitForTheme(page, 'material', true);
  const radius = await page.evaluate(() => getComputedStyle(document.querySelector('#btn')).borderTopLeftRadius);
  assert.equal(radius, await tokenOf('--uix-radius'));
});

test('D2: follows OS dark mode live', async () => {
  await setSettings(world, { ...base, theme: 'minimal', followSystem: true, darkTheme: 'terminal' });
  await page.emulateMedia({ colorScheme: 'light' });
  await waitForTheme(page, 'minimal');
  await page.emulateMedia({ colorScheme: 'dark' });
  await waitForTheme(page, 'terminal');
  await page.emulateMedia({ colorScheme: 'light' });
  await waitForTheme(page, 'minimal');
});

test('C3: the background relay toggles the panel (Alt+Shift+U path)', async () => {
  const [sw] = browser.context.serviceWorkers().length
    ? browser.context.serviceWorkers()
    : [await browser.context.waitForEvent('serviceworker')];
  const relay = () =>
    sw.evaluate(async (type) => {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      await chrome.tabs.sendMessage(tab.id, { type }, { frameId: 0 });
    }, CFG.MESSAGE_TYPES.togglePanel);
  const before = await hostDisplay();
  await relay();
  await page.waitForFunction((tag) => document.querySelector(tag)?.style.display === 'block', CFG.HOST_TAG);
  await relay();
  await page.waitForFunction((tag) => document.querySelector(tag)?.style.display === 'none', CFG.HOST_TAG);
  assert.notEqual(before, 'block');
});

test('C4: excluded host renders nothing and cleans up', async () => {
  await setSettings(world, { ...base, theme: 'dark', excludedHosts: [new URL(test.origin).hostname] });
  await waitForTheme(page, null);
  const leftovers = await page.evaluate(
    (attrs) => attrs.reduce((n, a) => n + document.querySelectorAll(`[${a}]`).length, 0),
    [CFG.ATTR.layer, CFG.ATTR.brand],
  );
  assert.equal(leftovers, 0);
  const shadowColor = await page.evaluate(() => getComputedStyle(document.querySelector('#widget').shadowRoot.querySelector('#inner')).color);
  assert.equal(shadowColor, 'rgb(204, 0, 0)', 'shadow-root sheet is released');
});

test('custom accent is applied inline and readable', async () => {
  await setSettings(world, { ...base, theme: 'custom', accent: '#aa00ff' });
  await waitForTheme(page, 'custom');
  assert.equal(await tokenOf('--uix-accent'), '#aa00ff');
  assert.equal(await tokenOf('--uix-accent-fg'), '#ffffff');
});

test('no exceptions from the extension world', () => {
  assert.deepEqual(world.state.exceptions, []);
});
