'use strict';

/**
 * "Bundle" mode for images: download the captured image URLs into public/assets/.
 * The URLs come from a web page, so this is an SSRF surface:
 *  - http(s) only; hosts resolving to loopback / private / link-local ranges are refused
 *  - no redirects followed, timeout per file, size cap, raster image types only
 *    (SVG is refused: it can carry script and would run on the dev server's origin)
 * Known gap: DNS is resolved once for the check and again by fetch (rebinding window).
 * Acceptable for a tool bound to 127.0.0.1 and driven by its own user; noted in README.
 */
const dns = require('node:dns/promises');
const net = require('node:net');

const TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif' };
const LIMITS = { files: 30, bytes: 3 * 1024 * 1024, timeoutMs: 8000, concurrency: 4 };

function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return isPrivateAddress(v.slice(7));
  return v === '::' || v === '::1' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80');
}

async function readCapped(res, max) {
  const chunks = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.length;
    if (size > max) throw new Error('too large');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function createAssets({ lookup = (h) => dns.lookup(h, { all: true }), fetchImpl = fetch, log = console } = {}) {
  async function fetchOne(src, index) {
    let u;
    try {
      u = new URL(src);
    } catch {
      return null;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    const addrs = await lookup(u.hostname).catch(() => []);
    if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address))) return null;
    const res = await fetchImpl(u.href, { redirect: 'manual', signal: AbortSignal.timeout(LIMITS.timeoutMs) });
    const ext = TYPES[String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()];
    if (!res.ok || !ext) return null;
    const data = await readCapped(res, LIMITS.bytes);
    const name = `img-${index + 1}.${ext}`;
    return { src, path: `public/assets/${name}`, url: `/assets/${name}`, data };
  }

  /** @returns {Promise<Array<{src, path, url, data}>>} images that could be fetched safely */
  async function collectImages(urls) {
    const list = [...new Set(urls)].slice(0, LIMITS.files);
    const out = new Array(list.length).fill(null);
    let next = 0;
    async function worker() {
      while (next < list.length) {
        const i = next++;
        out[i] = await fetchOne(list[i], i).catch((e) => {
          log.warn(`[assets] skipped ${list[i]}: ${e.message}`);
          return null;
        });
      }
    }
    await Promise.all(Array.from({ length: LIMITS.concurrency }, worker));
    return out.filter(Boolean);
  }

  return { collectImages };
}

module.exports = { createAssets, isPrivateAddress, LIMITS };
