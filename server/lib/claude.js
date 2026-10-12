'use strict';

/**
 * Claude calls for /analyze and /generate.
 *
 * - Tool use returns the JSON. claude-sonnet-5-5 rejects forced tool_choice
 *   ("any" / "tool") with a 400, so tool_choice is "auto", the prompt names the tool,
 *   report_analysis is strict (schema-valid arguments), and a missing call gets one
 *   reminder turn. Every result is validated again here.
 * - /generate streams (large output) and uses eager input streaming; the input is
 *   validated before use because eager mode skips server-side validation.
 * - The SDK's own retries are off; withRetry does exponential backoff, max 3 retries,
 *   on 429 / 5xx / 529 / connection errors, honouring retry-after.
 * - Refusals: server-side fallback ("default") on models that support it, and a
 *   `refusal` stop reason is reported instead of being read as output.
 */
const sdk = require('@anthropic-ai/sdk');
const PC = require('../../src/pack-core.js');
const P = require('./prompts.js');
const { checkProject } = require('./project.js');

const Anthropic = sdk.default || sdk;
const FALLBACK_MODELS = new Set(['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-1']);
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
const RETRY_STATUS = new Set([408, 409, 429, 500, 502, 503, 504, 529]);

class ClaudeError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function isRetryable(e) {
  if (e instanceof Anthropic.APIUserAbortError) return false;
  if (e instanceof Anthropic.APIConnectionError) return true; // includes timeouts
  return e instanceof Anthropic.APIError && (RETRY_STATUS.has(e.status) || e.status >= 500);
}

function retryAfterMs(e) {
  const h = e && e.headers;
  const raw = h && (typeof h.get === 'function' ? h.get('retry-after') : h['retry-after']);
  const s = Number(raw);
  return Number.isFinite(s) && s > 0 ? s * 1000 : null;
}

async function withRetry(fn, { retries = 3, baseMs = 1000, maxMs = 30000, sleep, log }) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= retries || !isRetryable(e)) throw e;
      const backoff = Math.min(maxMs, baseMs * 2 ** attempt) * (0.5 + Math.random() / 2);
      const wait = Math.min(maxMs, retryAfterMs(e) ?? backoff);
      log.warn(`[claude] ${e.status || e.name}; retry ${attempt + 1}/${retries} in ${Math.round(wait)} ms`);
      await sleep(wait);
    }
  }
}

/** Error → short code for the extension. Never forwards SDK messages. */
function toCode(e) {
  if (e instanceof ClaudeError) return e.code;
  if (e instanceof Anthropic.RateLimitError || (e && e.status === 529)) return 'rate-limit';
  return 'server-error';
}

function createClaude({ env, cfg, client, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = console }) {
  const PACK = cfg.PACK;
  const api =
    client || new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 0, timeout: 10 * 60 * 1000 });
  const model = env.CLAUDE_MODEL;
  const retry = (fn) => withRetry(fn, { sleep, log });
  const ANALYZE_TOOL = P.analyzeTool(PACK);
  const ANALYZE_SYSTEM = P.analyzeSystem(PACK);
  const GENERATE_TOOLS = P.generateTools();
  const GENERATE_SYSTEM = P.generateSystem(PACK);

  function params(extra) {
    const p = { model, ...extra };
    if (FALLBACK_MODELS.has(model)) {
      p.betas = [FALLBACK_BETA];
      p.fallbacks = 'default';
    }
    return p;
  }

  /** Server keeps at most maxRequiredQuestions required; extras are demoted, not dropped. */
  function finalizeAnalysis(input) {
    let required = 0;
    const questions = PC.sanitizeQuestions(input && input.questions, PACK).map((q) =>
      q.required && ++required > PACK.maxRequiredQuestions ? { ...q, required: false } : q,
    );
    const suggested = input && input.suggested;
    return {
      suggested: {
        stack: PC.sanitizeStack(suggested && suggested.stack, PACK),
        assets: PC.sanitizeAssets(suggested && suggested.assets, PACK),
      },
      summary: typeof input.summary === 'string' ? input.summary.trim().slice(0, PACK.maxTextLength) : '',
      questions,
    };
  }

  async function analyze({ capture, locale }, { signal } = {}) {
    const messages = [{ role: 'user', content: `Locale: ${locale}\n\nCapture:\n${JSON.stringify(capture)}` }];
    for (let turn = 0; turn < 2; turn += 1) {
      const msg = await retry(() =>
        api.beta.messages.create(
          params({
            max_tokens: 16000,
            system: ANALYZE_SYSTEM,
            tools: [ANALYZE_TOOL],
            tool_choice: { type: 'auto' },
            output_config: { effort: 'medium' },
            messages,
          }),
          { signal },
        ),
      );
      if (msg.stop_reason === 'refusal') throw new ClaudeError('refusal');
      if (msg.stop_reason === 'max_tokens') throw new ClaudeError('bad-response');
      const call = msg.content.find((b) => b.type === 'tool_use' && b.name === ANALYZE_TOOL.name);
      if (call && call.input && typeof call.input === 'object') return finalizeAnalysis(call.input);
      messages.push({ role: 'assistant', content: msg.content }, { role: 'user', content: P.REMIND_ANALYZE });
    }
    throw new ClaudeError('bad-response');
  }

  function generateContent(req) {
    const decisions = { stack: req.stack, assets: req.assets, answers: req.answers, bundledImages: req.bundledImages };
    return [
      `Locale: ${req.locale}`,
      `Analysis summary: ${req.summary || '(none)'}`,
      `Decisions (binding):\n${JSON.stringify(decisions, null, 2)}`,
      `Capture:\n${JSON.stringify(req.capture)}`,
    ].join('\n\n');
  }

  /** @returns {{ status: 'ok', files } | { status: 'need_clarification', questions }} */
  async function generate(req, { signal } = {}) {
    const messages = [{ role: 'user', content: generateContent(req) }];
    for (let turn = 0; turn < 3; turn += 1) {
      let msg;
      try {
        msg = await retry(() =>
          api.beta.messages
            .stream(
              params({
                max_tokens: 64000,
                system: GENERATE_SYSTEM,
                tools: GENERATE_TOOLS,
                tool_choice: { type: 'auto', disable_parallel_tool_use: true },
                output_config: { effort: 'high' },
                messages,
              }),
              { signal },
            )
            .finalMessage(),
        );
      } catch (e) {
        // Eager input streaming can surface unparseable tool JSON as a plain error;
        // re-issue the turn. Typed API errors (auth, rate limit, abort) propagate.
        if (e instanceof Anthropic.APIError || (e && e.name === 'AbortError')) throw e;
        log.warn('[claude] tool input was not valid JSON; re-issuing');
        continue;
      }
      if (msg.stop_reason === 'refusal') throw new ClaudeError('refusal');
      if (msg.stop_reason === 'max_tokens') throw new ClaudeError('incomplete-project');
      const call = msg.content.find((b) => b.type === 'tool_use');
      let problem = null;
      if (!call) {
        messages.push({ role: 'assistant', content: msg.content }, { role: 'user', content: P.REMIND_GENERATE });
        continue;
      }
      if (call.name === 'need_clarification') {
        const questions = PC.sanitizeQuestions(call.input && call.input.questions, PACK, { max: PACK.maxRequiredQuestions }).map(
          (q) => ({ ...q, required: true }),
        );
        if (questions.length) return { status: 'need_clarification', questions };
        problem = `need_clarification needs 1 to ${PACK.maxRequiredQuestions} questions, each with an id, a question and 2 to 6 options.`;
      } else if (call.name === 'emit_project') {
        const check = checkProject(call.input && call.input.files);
        if (check.ok) return { status: 'ok', files: check.files };
        if (check.code === 'unsafe-path') throw new ClaudeError('unsafe-path'); // never repaired
        problem = check.problem;
      } else {
        problem = 'Unknown tool. Use emit_project or need_clarification.';
      }
      messages.push(
        { role: 'assistant', content: msg.content },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: call.id, is_error: true, content: problem }] },
      );
    }
    throw new ClaudeError('incomplete-project');
  }

  return { analyze, generate };
}

module.exports = { createClaude, withRetry, isRetryable, toCode, ClaudeError, Anthropic };
