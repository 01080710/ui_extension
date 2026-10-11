'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** Split on commas that are not inside parentheses or brackets. */
function splitTopLevel(text, sep = ',') {
  const out = [];
  let depth = 0;
  let buf = '';
  for (const ch of text) {
    if (ch === '(' || ch === '[') depth += 1;
    if (ch === ')' || ch === ']') depth -= 1;
    if (ch === sep && depth === 0) {
      out.push(buf);
      buf = '';
    } else buf += ch;
  }
  out.push(buf);
  return out.map((s) => s.trim()).filter(Boolean);
}

/** Flat rule parser — enough for app.css, which uses no at-rules or nesting. */
function parseCss(css) {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(clean))) {
    const decls = {};
    splitTopLevel(m[2], ';').forEach((d) => {
      const i = d.indexOf(':');
      if (i > 0) decls[d.slice(0, i).trim()] = d.slice(i + 1).trim();
    });
    rules.push({ selectors: splitTopLevel(m[1].replace(/\s+/g, ' ')), decls });
  }
  return { rules, clean };
}

/** Collect token values per theme id from `html[data-uix-theme="id"]` blocks. */
function themeTokens(rules, themeAttr) {
  const re = new RegExp(`^html\\[${themeAttr}="([a-z0-9-]+)"\\]$`);
  const out = {};
  rules.forEach((r) => {
    if (r.selectors.length !== 1) return;
    const m = r.selectors[0].match(re);
    if (!m) return;
    const tokens = Object.fromEntries(Object.entries(r.decls).filter(([k]) => k.startsWith('--')));
    if (Object.keys(tokens).length) out[m[1]] = { ...(out[m[1]] || {}), ...tokens };
  });
  return out;
}

/** In-memory stand-in for document.documentElement. */
function fakeRoot() {
  const attrs = new Map();
  const props = new Map();
  return {
    setAttribute: (k, v) => attrs.set(k, String(v)),
    getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
    hasAttribute: (k) => attrs.has(k),
    removeAttribute: (k) => attrs.delete(k),
    style: {
      setProperty: (k, v) => props.set(k, String(v)),
      getPropertyValue: (k) => props.get(k) || '',
      removeProperty: (k) => props.delete(k),
    },
    _attrs: attrs,
    _props: props,
  };
}

module.exports = { ROOT, read, splitTopLevel, parseCss, themeTokens, fakeRoot };
