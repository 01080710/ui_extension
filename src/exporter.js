/**
 * A1 — turn the active theme's computed tokens into files a real project can use.
 * Pure string builders; content.js only reads values and triggers the download.
 *
 * Formats
 *   dtcg      Design Tokens Community Group format (2025.10 stable)
 *   css       plain :root custom properties, extension-neutral names
 *   tailwind  Tailwind CSS v4 `@theme` block
 *
 * Every file carries provenance (theme, mode, source host, time, UIX version) so a
 * delivered file can be traced back to the comparison session that produced it.
 * Only the hostname is recorded — never the path or query, which can hold private data.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.UIX_EXPORT = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Extension token → neutral export name, DTCG group path/type, Tailwind v4 variable.
  const TOKEN_MAP = {
    '--uix-scheme': { name: 'color-scheme', path: ['colorScheme'], type: null, tw: null },
    '--uix-bg': { name: 'color-bg', path: ['color', 'bg'], type: 'color', tw: '--color-bg' },
    '--uix-surface': { name: 'color-surface', path: ['color', 'surface'], type: 'color', tw: '--color-surface' },
    '--uix-fg': { name: 'color-fg', path: ['color', 'fg'], type: 'color', tw: '--color-fg' },
    '--uix-muted': { name: 'color-muted', path: ['color', 'muted'], type: 'color', tw: '--color-muted' },
    '--uix-border': { name: 'color-border', path: ['color', 'border'], type: 'color', tw: '--color-border' },
    '--uix-link': { name: 'color-link', path: ['color', 'link'], type: 'color', tw: '--color-link' },
    '--uix-accent': { name: 'color-accent', path: ['color', 'accent'], type: 'color', tw: '--color-accent' },
    '--uix-accent-fg': { name: 'color-accent-fg', path: ['color', 'accentFg'], type: 'color', tw: '--color-accent-fg' },
    '--uix-focus': { name: 'color-focus', path: ['color', 'focus'], type: 'color', tw: '--color-focus' },
    '--uix-brand-bg': { name: 'color-brand-bg', path: ['color', 'brandBg'], type: 'color', tw: '--color-brand-bg' },
    '--uix-brand-fg': { name: 'color-brand-fg', path: ['color', 'brandFg'], type: 'color', tw: '--color-brand-fg' },
    '--uix-radius': { name: 'radius', path: ['radius', 'base'], type: 'dimension', tw: '--radius-theme' },
    '--uix-shadow': { name: 'shadow', path: ['shadow', 'base'], type: null, tw: '--shadow-theme' },
    '--uix-ring': { name: 'border-width', path: ['border', 'width'], type: 'dimension', tw: null },
    '--uix-space': { name: 'space-unit', path: ['space', 'unit'], type: 'dimension', tw: '--spacing-theme' },
    '--uix-font': { name: 'font-family', path: ['font', 'family'], type: 'fontFamily', tw: '--font-theme' },
    '--uix-leading': { name: 'line-height', path: ['font', 'lineHeight'], type: 'number', tw: '--leading-theme' },
  };

  // Values come from our own stylesheet, but never let one break out of a declaration.
  const SAFE_VALUE = /^[^;{}<>\\`]*$/;
  const isSafe = (v) => typeof v === 'string' && v.length > 0 && v.length < 512 && SAFE_VALUE.test(v);

  /** readVar(name) → computed value. Unsafe or empty values are dropped. */
  function collectTokens(readVar, names) {
    const out = {};
    names.forEach((n) => {
      const v = String(readVar(n) || '').trim();
      if (isSafe(v)) out[n] = v;
    });
    return out;
  }

  function splitList(v) {
    const parts = [];
    let depth = 0;
    let buf = '';
    for (const ch of v) {
      if (ch === '(') depth += 1;
      if (ch === ')') depth -= 1;
      if (ch === ',' && depth === 0) {
        parts.push(buf.trim());
        buf = '';
      } else buf += ch;
    }
    if (buf.trim()) parts.push(buf.trim());
    return parts;
  }

  function hexToSrgb(hex) {
    const m = /^#([0-9a-f]{6})$/i.exec(hex);
    if (!m) return null;
    const n = [0, 2, 4].map((i) => Math.round((parseInt(m[1].slice(i, i + 2), 16) / 255) * 1e4) / 1e4);
    return { colorSpace: 'srgb', components: n, hex: hex.toLowerCase() };
  }

  function toDimension(v) {
    const m = /^(-?\d*\.?\d+)(px|rem)?$/.exec(v);
    if (!m) return null;
    return { value: Number(m[1]), unit: m[2] || 'px' };
  }

  function dtcgValue(type, v) {
    switch (type) {
      case 'color':
        return hexToSrgb(v);
      case 'dimension':
        return toDimension(v);
      case 'fontFamily':
        return splitList(v).map((f) => f.replace(/^["']|["']$/g, ''));
      case 'number': {
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
      }
      default:
        return v;
    }
  }

  // Provenance fields, each validated by shape; anything else is dropped.
  const META_RULES = {
    theme: /^[a-z0-9-]{1,32}$/,
    mode: /^(default|enhanced)$/,
    fonts: /^(on|off)$/,
    source: /^(?=.{1,253}$)[a-z0-9-]+(\.[a-z0-9-]+)*$/,
    exportedAt: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/,
    uixVersion: /^\d+(\.\d+){0,3}$/,
  };

  function sanitizeMeta(meta) {
    const src = meta && typeof meta === 'object' ? meta : {};
    const out = {};
    Object.entries(META_RULES).forEach(([k, re]) => {
      const v = Object.prototype.hasOwnProperty.call(src, k) ? String(src[k]) : '';
      if (re.test(v)) out[k] = v;
    });
    return out;
  }

  const META_LABELS = { mode: 'mode', fonts: 'fonts', source: 'source', exportedAt: 'exported', uixVersion: 'uix' };

  /** Comment header shared by the CSS-based formats. */
  function cssHeader(themeId, meta, suffix = '') {
    const lines = Object.entries(META_LABELS)
      .filter(([k]) => k in meta)
      .map(([k, label]) => ` * ${label}: ${meta[k]}`);
    return `/* UIX theme "${themeId}"${suffix}\n${lines.join('\n')}${lines.length ? '\n' : ''} */\n`;
  }

  function toDTCG(themeId, tokens, meta = {}) {
    const doc = { $description: `UIX theme "${themeId}"` };
    if (Object.keys(meta).length) doc.$extensions = { 'dev.uix.export': meta };
    Object.entries(TOKEN_MAP).forEach(([src, spec]) => {
      if (!(src in tokens)) return;
      const value = dtcgValue(spec.type, tokens[src]);
      if (value === null) return;
      let node = doc;
      spec.path.slice(0, -1).forEach((p) => {
        node[p] = node[p] || {};
        node = node[p];
      });
      const leaf = { $value: value };
      if (spec.type) leaf.$type = spec.type;
      node[spec.path[spec.path.length - 1]] = leaf;
    });
    return `${JSON.stringify(doc, null, 2)}\n`;
  }

  function toCSS(themeId, tokens, meta = {}) {
    const lines = Object.entries(TOKEN_MAP)
      .filter(([src]) => src in tokens)
      .map(([src, spec]) => `  --${spec.name}: ${tokens[src]};`);
    const scheme = tokens['--uix-scheme'];
    if (scheme) lines.push(`  color-scheme: ${scheme};`);
    return `${cssHeader(themeId, meta)}:root {\n${lines.join('\n')}\n}\n`;
  }

  function toTailwind(themeId, tokens, meta = {}) {
    const lines = Object.entries(TOKEN_MAP)
      .filter(([src, spec]) => spec.tw && src in tokens)
      .map(([src, spec]) => `  ${spec.tw}: ${tokens[src]};`);
    return `${cssHeader(themeId, meta, ' — Tailwind CSS v4')}@import "tailwindcss";\n\n@theme {\n${lines.join('\n')}\n}\n`;
  }

  const BUILDERS = { dtcg: toDTCG, css: toCSS, tailwind: toTailwind };

  /** @returns {{ filename: string, mime: string, body: string } | null} */
  function buildExport(formatId, themeId, tokens, formats, meta) {
    const fmt = formats.find((f) => f.id === formatId);
    const build = BUILDERS[formatId];
    if (!fmt || !build || !/^[a-z0-9-]+$/.test(themeId)) return null;
    const clean = sanitizeMeta({ ...meta, theme: themeId });
    return { filename: `uix-${themeId}.${fmt.ext}`, mime: fmt.mime, body: build(themeId, tokens, clean) };
  }

  return { TOKEN_MAP, collectTokens, sanitizeMeta, toDTCG, toCSS, toTailwind, buildExport };
});
