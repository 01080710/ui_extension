'use strict';

/**
 * Validation of the files the AI returns, before anything is zipped.
 *  - unsafe path (absolute, "..", backslash, drive letter, odd characters) → whole
 *    generation rejected; never silently dropped or "fixed"
 *  - fixable problems (missing package.json "dev" script, reserved folder, size) →
 *    described in plain text so the model can repair them in one more turn
 */
const SEGMENT = /^[A-Za-z0-9._@-]+$/;
const RESERVED = ['public/assets', 'node_modules', '.git', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', '.env'];
const LIMITS = { files: 80, fileBytes: 200 * 1024, totalBytes: 2 * 1024 * 1024, path: 200 };

/** Normalised relative POSIX path, or null when the path could escape the project folder. */
function safePath(p) {
  if (typeof p !== 'string' || !p || p.length > LIMITS.path) return null;
  if (p.includes('\\') || p.includes('\0') || p.startsWith('/') || /^[A-Za-z]:/.test(p)) return null;
  const segments = p.split('/');
  if (segments.some((s) => !s || s === '.' || s === '..' || !SEGMENT.test(s))) return null;
  return segments.join('/');
}

const isReserved = (path) => RESERVED.some((r) => path === r || path.startsWith(`${r}/`));

/**
 * @returns {{ ok: true, files } | { ok: false, code: 'unsafe-path' } | { ok: false, problem: string }}
 */
function checkProject(files) {
  if (!Array.isArray(files) || !files.length) return { ok: false, problem: 'files must be a non-empty array of {path, content}.' };
  if (files.length > LIMITS.files) return { ok: false, problem: `Too many files (${files.length}); keep it under ${LIMITS.files}.` };
  const out = [];
  const seen = new Set();
  let total = 0;
  for (const f of files) {
    const path = safePath(f && f.path);
    if (!path) return { ok: false, code: 'unsafe-path' };
    if (typeof f.content !== 'string') return { ok: false, problem: `${path}: content must be a string.` };
    if (seen.has(path.toLowerCase())) return { ok: false, problem: `${path} appears twice.` };
    if (isReserved(path)) return { ok: false, problem: `${path}: do not write ${RESERVED.join(', ')}.` };
    const bytes = Buffer.byteLength(f.content, 'utf8');
    total += bytes;
    if (bytes > LIMITS.fileBytes) return { ok: false, problem: `${path} is too large; split it into smaller components.` };
    if (total > LIMITS.totalBytes) return { ok: false, problem: 'The project is too large; rebuild only the captured section.' };
    seen.add(path.toLowerCase());
    out.push({ path, content: f.content });
  }
  let pkg = null;
  try {
    pkg = JSON.parse((out.find((f) => f.path === 'package.json') || {}).content);
  } catch {
    /* reported below */
  }
  if (!pkg || typeof pkg !== 'object') return { ok: false, problem: 'package.json at the project root is missing or not valid JSON.' };
  if (!pkg.scripts || typeof pkg.scripts.dev !== 'string') return { ok: false, problem: 'package.json needs a "dev" script so `npm run dev` starts the project.' };
  if (!out.some((f) => f.path === 'index.html')) return { ok: false, problem: 'index.html at the project root is required (Vite entry).' };
  return { ok: true, files: out };
}

module.exports = { safePath, checkProject, LIMITS, RESERVED };
