/**
 * Component pack — capture what the user is looking at as a compact JSON tree.
 * Runs in the content script; reads the DOM only (never writes, never serialises HTML).
 *
 * Kept:    visible elements intersecting [scrollY, scrollY + viewports × innerHeight),
 *          a whitelist of attributes and computed styles, text in document order,
 *          small SVG icons as validated path data, image URLs without query/hash.
 * Dropped: script/style/iframe…, hidden nodes, tracker pixels and hosts, form values,
 *          link targets, contenteditable/textarea text, our own panel.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.UIX_PACK_CAPTURE = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const PATH_D = /^[MmLlHhVvCcSsQqTtAaZz0-9eE.,+\-\s]+$/;
  const VIEWBOX = /^-?[\d.]+([\s,]+-?[\d.]+){3}$/;
  const FILL = /^(none|currentcolor|rgba?\([\d.,\s%/]+\))$/i;
  const URL_IN_CSS = /url\(\s*(['"]?)(.*?)\1\s*\)/i;

  function isTrackerHost(hostname, list) {
    return list.some((h) => hostname === h || hostname.endsWith(`.${h}`));
  }

  /** http(s) only, tracker hosts refused, query and hash stripped (they can carry private data). */
  function cleanUrl(raw, base, trackers) {
    try {
      const u = new URL(raw, base);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
      if (isTrackerHost(u.hostname, trackers)) return null;
      return `${u.origin}${u.pathname}`;
    } catch {
      return null;
    }
  }

  function captureOnce({ doc, win, cfg, host, theme, maxNodes }) {
    const C = cfg.PACK.capture;
    const top = win.scrollY;
    const bottom = top + win.innerHeight * C.viewports;
    const icons = [];
    const images = new Set();
    const fonts = new Set();
    let count = 0;
    let truncated = false;

    function styles(cs) {
      const out = {};
      C.styles.forEach((p) => {
        let v = cs.getPropertyValue(p).trim();
        if (!v || C.defaultValues.includes(v)) return;
        if (p === 'background-image') {
          const m = URL_IN_CSS.exec(v);
          if (m) {
            const url = cleanUrl(m[2], doc.baseURI, C.trackerHosts);
            if (!url) return;
            images.add(url);
            v = `url("${url}")`;
          }
        }
        if (p === 'font-family') fonts.add(v.split(',')[0].trim().replace(/^["']|["']$/g, ''));
        out[p] = v.slice(0, 300);
      });
      return out;
    }

    function icon(svg, rect) {
      if (icons.length >= C.maxIcons || rect.width > C.maxIconSize || rect.height > C.maxIconSize) return -1;
      const paths = [...svg.querySelectorAll('path')]
        .slice(0, C.maxIconPaths)
        .map((p) => ({ d: (p.getAttribute('d') || '').trim(), fill: win.getComputedStyle(p).fill }))
        .filter((p) => p.d && p.d.length <= C.maxIconPathLength && PATH_D.test(p.d))
        .map((p) => (FILL.test(p.fill) ? p : { d: p.d }));
      if (!paths.length) return -1;
      const vb = (svg.getAttribute('viewBox') || '').trim();
      icons.push({ viewBox: VIEWBOX.test(vb) ? vb : `0 0 ${Math.round(rect.width)} ${Math.round(rect.height)}`, paths });
      return icons.length - 1;
    }

    function text(node) {
      return node.nodeValue.replace(/\s+/g, ' ').trim().slice(0, C.maxText);
    }

    function walk(el, depth) {
      if (count >= maxNodes) {
        truncated = true;
        return null;
      }
      const tag = el.localName;
      if (C.skipTags.includes(tag) || tag === cfg.HOST_TAG) return null;
      const cs = win.getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return null;
      const rect = el.getBoundingClientRect();
      // <body> is always kept (it can be 0 px tall when the layout is absolutely positioned);
      // zero-height boxes are judged by their children instead of their own rect.
      const boxed = depth > 0 && cs.display !== 'contents';
      if (boxed && (rect.width === 0 || rect.height === 0) && cs.overflow !== 'visible') return null;
      if (boxed && rect.height > 0 && (rect.top + top >= bottom || rect.bottom + top <= top)) return null;

      const node = {
        t: tag,
        r: [Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height)],
      };

      if (tag === 'img') {
        // 1×1 images are tracking pixels; a refused URL means a tracker host.
        if (el.complete && el.naturalWidth <= 1 && el.naturalHeight <= 1) return null;
        const src = cleanUrl(el.currentSrc || el.getAttribute('src') || '', doc.baseURI, C.trackerHosts);
        if (!src) return null;
        images.add(src);
        node.src = src;
      }
      if (tag === 'video') {
        const poster = cleanUrl(el.getAttribute('poster') || '', doc.baseURI, C.trackerHosts);
        if (poster) {
          images.add(poster);
          node.src = poster;
        }
      }
      if (tag === 'a') node.link = true; // the target is never sent

      count += 1;
      const attrs = {};
      C.attrs.forEach((a) => {
        const v = el.getAttribute(a);
        if (v) attrs[a] = v.slice(0, C.maxText);
      });
      if (Object.keys(attrs).length) node.a = attrs;
      node.s = styles(cs);

      if (tag === 'svg') {
        const i = icon(el, rect);
        if (i >= 0) node.icon = i;
        return node; // children are path data, already handled
      }

      const privateText = tag === 'textarea' || el.isContentEditable;
      const kids = [];
      if (depth < C.maxDepth) {
        const childNodes = el.shadowRoot ? [...el.shadowRoot.childNodes, ...el.childNodes] : [...el.childNodes];
        for (const child of childNodes) {
          if (child.nodeType === 3 && !privateText) {
            const s = text(child);
            if (s) kids.push(s);
          } else if (child.nodeType === 1) {
            const sub = walk(child, depth + 1);
            if (sub) kids.push(sub);
          }
        }
      }
      if (kids.length) node.c = kids;
      return node;
    }

    const tree = doc.body ? walk(doc.body, 0) : null;
    return {
      version: 1,
      page: {
        title: String(doc.title || '').slice(0, 200),
        host,
        lang: String(doc.documentElement.lang || '').slice(0, 20),
        viewport: { w: win.innerWidth, h: Math.round(win.innerHeight * C.viewports) },
      },
      theme,
      tree,
      icons,
      images: [...images].slice(0, C.maxImages),
      fonts: [...fonts].filter(Boolean).slice(0, 20),
      truncated,
    };
  }

  /** Halves the node budget until the JSON fits PACK.capture.maxChars. */
  function capture(opts) {
    const C = opts.cfg.PACK.capture;
    let maxNodes = C.maxNodes;
    let out = captureOnce({ ...opts, maxNodes });
    while (JSON.stringify(out).length > C.maxChars && maxNodes > 50) {
      maxNodes = Math.floor(maxNodes / 2);
      out = { ...captureOnce({ ...opts, maxNodes }), truncated: true };
    }
    return out;
  }

  return { capture, cleanUrl, isTrackerHost };
});
