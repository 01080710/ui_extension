'use strict';

/**
 * Server-side DOM simplification. The extension already captures a compact tree, but
 * the server never trusts it: every node is rebuilt from a whitelist before it goes
 * into a prompt. Removes script-like tags, hidden nodes, tracker URLs and anything
 * that is not plain data.
 */
const { cleanUrl } = require('../../src/pack-capture.js');

const TAG = /^[a-z][a-z0-9-]{0,30}$/;
const PATH_D = /^[MmLlHhVvCcSsQqTtAaZz0-9eE.,+\-\s]+$/;
const VIEWBOX = /^-?[\d.]+([\s,]+-?[\d.]+){3}$/;
const FILL = /^(none|currentcolor|rgba?\([\d.,\s%/]+\))$/i;
const HOST = /^(?=.{1,253}$)[a-z0-9-]+(\.[a-z0-9-]+)*$/;
const FONT = /^[\w\s.'-]{1,60}$/;
const UNSAFE_STYLE = /[<>{};\\]|expression\(|javascript:|@import/i;
const URL_IN_CSS = /url\(\s*(['"]?)(.*?)\1\s*\)/i;
const HIDDEN = { display: 'none', visibility: 'hidden', opacity: '0' };
const LIMITS = { nodes: 1500, depth: 60, text: 300, attr: 200, style: 300, icons: 60, iconPaths: 16, iconPath: 6000, images: 80, tokens: 12000 };

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const str = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max) : '');
// Multi-line text (token files): keeps newlines, drops other control characters.
const lines = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, ' ').slice(0, max) : '');
const int = (v) => (Number.isFinite(v) ? Math.max(-1e5, Math.min(1e5, Math.round(v))) : 0);

function simplifyCapture(raw, cfg) {
  const C = cfg.PACK.capture;
  const src = isObj(raw) ? raw : {};
  const skip = new Set(C.skipTags);
  const trackers = C.trackerHosts;
  const images = new Set();
  let count = 0;
  let truncated = src.truncated === true;

  const safeUrl = (u) => (typeof u === 'string' ? cleanUrl(u, undefined, trackers) : null);

  function styles(s) {
    const out = {};
    if (!isObj(s)) return out;
    C.styles.forEach((p) => {
      let v = str(s[p], LIMITS.style);
      if (!v || UNSAFE_STYLE.test(v)) return;
      if (p === 'background-image' && /url\(/i.test(v)) {
        const m = URL_IN_CSS.exec(v);
        const url = m && safeUrl(m[2]);
        if (!url) return;
        images.add(url);
        v = `url("${url}")`;
      }
      out[p] = v;
    });
    return out;
  }

  function node(n, depth) {
    if (typeof n === 'string') return str(n, LIMITS.text) || null;
    if (!isObj(n) || depth > LIMITS.depth) return null;
    if (count >= LIMITS.nodes) {
      truncated = true;
      return null;
    }
    const tag = typeof n.t === 'string' && TAG.test(n.t) ? n.t : null;
    if (!tag || skip.has(tag)) return null;
    const s = styles(n.s);
    if (Object.entries(HIDDEN).some(([k, v]) => s[k] === v)) return null;
    const out = { t: tag };
    if (Array.isArray(n.r) && n.r.length === 4) out.r = n.r.map(int);
    if (tag === 'img' || tag === 'video') {
      const url = safeUrl(n.src);
      if (url) {
        images.add(url);
        out.src = url;
      } else if (tag === 'img') return null; // tracker or non-http image
    }
    count += 1;
    if (n.link === true) out.link = true;
    if (Number.isInteger(n.icon) && n.icon >= 0) out.icon = n.icon;
    if (isObj(n.a)) {
      const a = {};
      C.attrs.forEach((k) => {
        const v = str(n.a[k], LIMITS.attr);
        if (v) a[k] = v;
      });
      if (Object.keys(a).length) out.a = a;
    }
    if (Object.keys(s).length) out.s = s;
    if (Array.isArray(n.c)) {
      const kids = n.c.map((c) => node(c, depth + 1)).filter(Boolean);
      if (kids.length) out.c = kids;
    }
    return out;
  }

  const icons = (Array.isArray(src.icons) ? src.icons : []).slice(0, LIMITS.icons).map((ic) => {
    const vb = isObj(ic) ? str(ic.viewBox, 80) : '';
    const paths = (isObj(ic) && Array.isArray(ic.paths) ? ic.paths : [])
      .slice(0, LIMITS.iconPaths)
      .filter((p) => isObj(p) && typeof p.d === 'string' && p.d.length <= LIMITS.iconPath && PATH_D.test(p.d))
      .map((p) => (typeof p.fill === 'string' && FILL.test(p.fill) ? { d: p.d, fill: p.fill } : { d: p.d }));
    return { viewBox: VIEWBOX.test(vb) ? vb : '0 0 24 24', paths };
  });

  const tree = isObj(src.tree) ? node(src.tree, 0) : null; // the root must be an element, not text
  (Array.isArray(src.images) ? src.images : []).forEach((u) => {
    const url = safeUrl(u);
    if (url) images.add(url);
  });

  const page = isObj(src.page) ? src.page : {};
  const viewport = isObj(page.viewport) ? page.viewport : {};
  const theme = isObj(src.theme) ? src.theme : null;
  const host = str(page.host, 253);

  return {
    page: {
      title: str(page.title, 200),
      host: HOST.test(host) ? host : '',
      lang: /^[A-Za-z-]{0,20}$/.test(page.lang || '') ? page.lang || '' : '',
      viewport: { w: int(viewport.w), h: int(viewport.h) },
    },
    theme:
      theme && /^[a-z0-9-]{1,32}$/.test(theme.id || '')
        ? {
            id: theme.id,
            mode: theme.mode === 'enhanced' ? 'enhanced' : 'default',
            css: lines(theme.css, LIMITS.tokens),
            tailwind: lines(theme.tailwind, LIMITS.tokens),
          }
        : null,
    tree,
    icons,
    images: [...images].slice(0, LIMITS.images),
    fonts: (Array.isArray(src.fonts) ? src.fonts : []).filter((f) => typeof f === 'string' && FONT.test(f)).slice(0, 20),
    truncated,
  };
}

module.exports = { simplifyCapture, LIMITS };
