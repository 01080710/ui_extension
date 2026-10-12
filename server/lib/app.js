'use strict';

/**
 * HTTP layer. Every request must pass all three checks:
 *   Host        exactly 127.0.0.1:<port>     (blocks DNS-rebinding pages)
 *   Origin      exactly EXTENSION_ORIGIN     (only our extension's worker)
 *   X-Local-Token equals LOCAL_TOKEN         (constant-time compare)
 * No CORS headers are sent, so no web page can read a response.
 * Error responses carry a short code only; the API key and SDK messages never leave.
 */
const http = require('node:http');
const crypto = require('node:crypto');
const PC = require('../../src/pack-core.js');
const { simplifyCapture } = require('./simplify.js');
const { zipFiles } = require('./zip.js');
const { toCode } = require('./claude.js');

const MAX_BODY = 4 * 1024 * 1024;
const LOCALE = /^[A-Za-z]{2,3}([_-][A-Za-z0-9]{2,8})*$/;
const digest = (s) => crypto.createHash('sha256').update(String(s)).digest();

class HttpError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) {
      reject(new HttpError(415, 'bad-request'));
      return;
    }
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size <= MAX_BODY) chunks.push(c); // past the cap: keep draining so the 413 can be sent
    });
    req.on('end', () => {
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'too-large'));
        return;
      }
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('not an object');
        resolve(body);
      } catch {
        reject(new HttpError(400, 'bad-request'));
      }
    });
    req.on('error', reject);
  });
}

function createApp({ env, cfg, claude, assets, log = console }) {
  const PACK = cfg.PACK;
  const { hostname, port } = new URL(PACK.server);
  const expectedHost = `${hostname}:${port}`;
  const tokenDigest = digest(env.LOCAL_TOKEN);

  function authorized(req) {
    if (req.headers.host !== expectedHost) return false;
    if (req.headers.origin !== env.EXTENSION_ORIGIN) return false;
    return crypto.timingSafeEqual(digest(req.headers['x-local-token'] || ''), tokenDigest);
  }

  const baseHeaders = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };

  function sendJson(res, status, body) {
    res.writeHead(status, { ...baseHeaders, 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  }

  const locale = (v) => (typeof v === 'string' && LOCALE.test(v) ? v : 'en');

  async function analyze(body, signal) {
    const capture = simplifyCapture(body.capture, cfg);
    if (!capture.tree) throw new HttpError(400, 'capture-failed');
    return claude.analyze({ capture, locale: locale(body.locale) }, { signal });
  }

  /** Validates the card results again: the extension is trusted for intent, not for data. */
  function generateRequest(body) {
    const stack = PC.sanitizeStack(body.stack, PACK);
    const chosen = PC.sanitizeAssets(body.assets, PACK);
    if (Object.values(stack).some((v) => !v) || Object.values(chosen).some((v) => !v)) throw new HttpError(400, 'bad-request');
    const capture = simplifyCapture(body.capture, cfg);
    if (!capture.tree) throw new HttpError(400, 'capture-failed');
    const answers = (Array.isArray(body.answers) ? body.answers : [])
      .slice(0, PACK.maxQuestions)
      .filter((a) => a && typeof a.question === 'string' && typeof a.answer === 'string')
      .map((a) => ({
        question: a.question.slice(0, PACK.maxTextLength),
        answer: a.answer.slice(0, PACK.maxTextLength),
      }));
    const summary = typeof body.summary === 'string' ? body.summary.slice(0, PACK.maxTextLength) : '';
    return { capture, stack, assets: chosen, answers, summary, locale: locale(body.locale) };
  }

  function zipName(capture) {
    const slug = (capture.page.host || 'page').replace(/[^a-z0-9-]+/g, '-').slice(0, 40);
    const theme = capture.theme ? `-${capture.theme.id}` : '';
    return `uix-pack-${slug}${theme}`;
  }

  async function generate(req, res, body, signal) {
    const input = generateRequest(body); // throws before streaming starts → plain HTTP error
    res.writeHead(200, { ...baseHeaders, 'Content-Type': 'application/x-ndjson; charset=utf-8' });
    const emit = (evt) => res.write(`${JSON.stringify(evt)}\n`);
    try {
      emit({ type: 'phase', phase: PACK.phases[1].id });
      const images = input.assets.images === 'bundle' ? await assets.collectImages(input.capture.images) : [];
      const out = await claude.generate(
        { ...input, bundledImages: images.map(({ src, url }) => ({ src, url })) },
        { signal },
      );
      if (out.status === 'need_clarification') {
        emit({ type: 'need_clarification', questions: out.questions });
        return;
      }
      emit({ type: 'phase', phase: PACK.phases[2].id });
      const name = zipName(input.capture);
      const zip = await zipFiles([...out.files, ...images.map((i) => ({ path: i.path, content: i.data }))], name);
      emit({ type: 'done', filename: `${name}.zip`, zip: zip.toString('base64') });
    } catch (e) {
      if (!signal.aborted) log.error(`[generate] ${e.code || e.name}: ${e.message}`);
      emit({ type: 'error', code: toCode(e) });
    } finally {
      res.end();
    }
  }

  async function handle(req, res) {
    const controller = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) controller.abort(); // extension gave up: stop paying for tokens
    });
    try {
      if (!authorized(req)) throw new HttpError(403, 'unauthorized');
      if (req.method !== 'POST') throw new HttpError(405, 'bad-request');
      if (req.url === '/analyze') {
        const body = await readJson(req);
        sendJson(res, 200, await analyze(body, controller.signal));
      } else if (req.url === '/generate') {
        await generate(req, res, await readJson(req), controller.signal);
      } else throw new HttpError(404, 'bad-request');
    } catch (e) {
      if (res.headersSent) return;
      if (e instanceof HttpError) {
        sendJson(res, e.status, { code: e.code });
        return;
      }
      if (!controller.signal.aborted) log.error(`[${req.url}] ${e.code || e.name}: ${e.message}`);
      const code = toCode(e);
      sendJson(res, code === 'rate-limit' ? 429 : 502, { code });
    }
  }

  return http.createServer((req, res) => {
    handle(req, res);
  });
}

module.exports = { createApp };
