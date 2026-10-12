'use strict';

const DEFAULT_MODEL = 'claude-sonnet-5-5';
const TOKEN = /^[\x21-\x7e]{24,256}$/; // same rule as the extension's token card
const ORIGIN = /^(chrome-extension|moz-extension):\/\/[a-z0-9-]{8,64}$/;

/** Validates process.env; throws with every problem at once so setup is one round trip. */
function loadEnv(src) {
  const problems = [];
  const key = String(src.ANTHROPIC_API_KEY || '').trim();
  const token = String(src.LOCAL_TOKEN || '').trim();
  const origin = String(src.EXTENSION_ORIGIN || '').trim();
  const model = String(src.CLAUDE_MODEL || '').trim() || DEFAULT_MODEL;
  if (!key) problems.push('ANTHROPIC_API_KEY is empty');
  if (!TOKEN.test(token)) problems.push('LOCAL_TOKEN must be 24-256 printable characters without spaces');
  if (!ORIGIN.test(origin)) problems.push('EXTENSION_ORIGIN must look like chrome-extension://<extension id>');
  if (!/^[a-z0-9.-]{3,64}$/.test(model)) problems.push('CLAUDE_MODEL is not a model id');
  if (problems.length) throw new Error(`server/.env: ${problems.join('; ')}`);
  return { ANTHROPIC_API_KEY: key, LOCAL_TOKEN: token, EXTENSION_ORIGIN: origin, CLAUDE_MODEL: model };
}

module.exports = { loadEnv, DEFAULT_MODEL };
