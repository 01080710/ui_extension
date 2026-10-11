'use strict';

/**
 * In-page probes, serialised into page.evaluate — must stay self-contained.
 *
 * sample(): pick up to N visible, text-bearing elements in the first few
 *           viewports and remember them on window.__uixBench.
 * probe():  for each remembered element report colour, effective background,
 *           contrast and position, plus whether colours came from theme tokens.
 *           Also reports small SVG / icon-font glyphs: visible means ≥ 3:1 against
 *           the effective background (WCAG 1.4.11). <img> icons cannot be judged
 *           without reading pixels, so they are not sampled.
 */

function sample({ max, viewports }) {
  window.scrollTo(0, 0);
  const limitY = window.innerHeight * viewports;
  const out = [];
  const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_ELEMENT);
  for (let el = walker.currentNode; el && out.length < max; el = walker.nextNode()) {
    if (el.closest('svg, uix-panel-host')) continue;
    const hasText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 1);
    if (!hasText) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility !== 'visible' || Number(cs.opacity) === 0 || cs.display === 'none') continue;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2 || r.bottom < 0 || r.top > limitY) continue;
    out.push(el);
  }
  const ICON = 'svg, i, [class*="icon" i], [class*="fa-"], [class*="material-symbols"], [class*="material-icons"]';
  const icons = [];
  for (const el of document.querySelectorAll(ICON)) {
    if (icons.length >= 120) break;
    if (el.closest('uix-panel-host') || (el.parentElement && el.parentElement.closest('svg'))) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 6 || r.height < 6 || r.width > 64 || r.height > 64 || r.bottom < 0 || r.top > limitY) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility !== 'visible' || Number(cs.opacity) === 0) continue;
    icons.push(el);
  }
  window.__uixBench = { els: out, icons };
  return out.length;
}

function probe({ tokenNames, themeAttr }) {
  const els = (window.__uixBench && window.__uixBench.els) || [];
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const cache = new Map();

  // Any CSS colour (rgb, oklch, color(), named) → [r,g,b,a] in sRGB 0-255 / 0-1.
  function rgba(str) {
    if (cache.has(str)) return cache.get(str);
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = '#000';
    ctx.fillStyle = str;
    ctx.fillRect(0, 0, 1, 1);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    const v = [d[0], d[1], d[2], d[3] / 255];
    cache.set(str, v);
    return v;
  }
  const lum = ([r, g, b]) => {
    const f = (c) => {
      const s = c / 255;
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const contrast = (a, b) => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  const over = (top, under) => {
    const a = top[3];
    return [0, 1, 2].map((i) => top[i] * a + under[i] * (1 - a)).concat(1);
  };
  const near = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) <= 6;

  /** Composite backgrounds up the ancestor chain. null = image/gradient (unknown). */
  function effectiveBg(el) {
    const layers = [];
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.backgroundImage !== 'none') return null;
      const c = rgba(cs.backgroundColor);
      if (c[3] > 0) layers.push(c);
      if (c[3] >= 0.99) break;
    }
    let acc = [255, 255, 255, 1]; // canvas default
    for (let i = layers.length - 1; i >= 0; i -= 1) acc = over(layers[i], acc);
    return acc;
  }

  const root = document.documentElement;
  const theme = root.getAttribute(themeAttr);
  const rootCs = getComputedStyle(root);
  const tokens = {};
  tokenNames.forEach((n) => {
    const v = rootCs.getPropertyValue(n).trim();
    if (v.startsWith('#')) tokens[n] = rgba(v);
  });
  const fgTokens = ['--uix-fg', '--uix-link', '--uix-muted', '--uix-accent', '--uix-accent-fg', '--uix-bg', '--uix-brand-fg']
    .map((n) => tokens[n])
    .filter(Boolean);
  const bgTokens = ['--uix-bg', '--uix-surface', '--uix-accent', '--uix-fg', '--uix-border', '--uix-brand-bg']
    .map((n) => tokens[n])
    .filter(Boolean);

  const rows = [];
  for (const el of els) {
    if (!el.isConnected) {
      rows.push(null);
      continue;
    }
    const cs = getComputedStyle(el);
    const fgRaw = rgba(cs.color);
    const bg = effectiveBg(el);
    const fg = bg ? over(fgRaw, bg) : fgRaw;
    const size = parseFloat(cs.fontSize);
    const bold = Number(cs.fontWeight) >= 700;
    const large = size >= 24 || (bold && size >= 18.66);
    const r = el.getBoundingClientRect();
    rows.push({
      x: Math.round(r.left + window.scrollX),
      y: Math.round(r.top + window.scrollY),
      w: Math.round(r.width),
      h: Math.round(r.height),
      ratio: bg ? contrast(fg, bg) : null,
      need: large ? 3 : 4.5,
      fgToken: theme ? fgTokens.some((t) => near(fgRaw, t)) : null,
      bgToken: theme && bg ? bgTokens.some((t) => near(bg, t)) : null,
      inlineImportant: el.style.getPropertyPriority('color') === 'important',
      desc: theme && !fgTokens.some((t) => near(fgRaw, t))
        ? `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${typeof el.className === 'string' && el.className ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}` : ''} ${cs.color}`
        : null,
    });
  }
  // Icon glyph colour: SVG paint (fill, else stroke, of the svg or its first shape),
  // icon fonts use `color`. `currentColor` resolves to the computed colour.
  function iconColor(el) {
    const cs = getComputedStyle(el);
    if (el.namespaceURI !== 'http://www.w3.org/2000/svg') return cs.color;
    const shape = el.querySelector('path, circle, rect, polygon, ellipse, line, polyline, use') || el;
    const scs = getComputedStyle(shape);
    const paint = scs.fill && scs.fill !== 'none' ? scs.fill : scs.stroke;
    if (!paint || paint === 'none' || paint.startsWith('url(')) return null;
    return paint === 'currentcolor' || paint === 'currentColor' ? scs.color : paint;
  }
  const icons = ((window.__uixBench && window.__uixBench.icons) || []).map((el) => {
    if (!el.isConnected) return null;
    const c = iconColor(el);
    const bg = effectiveBg(el);
    if (!c || !bg) return { visible: null };
    const fg = rgba(c);
    if (fg[3] === 0) return { visible: null };
    return { visible: contrast(over(fg, bg), bg) >= 3 };
  });
  return { theme, rows, icons };
}

module.exports = { sample, probe };
