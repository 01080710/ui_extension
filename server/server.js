#!/usr/bin/env node
'use strict';

// Usage: npm start   (node --env-file=.env server.js)
const cfg = require('../src/config.js');
const { loadEnv } = require('./lib/env.js');
const { createClaude } = require('./lib/claude.js');
const { createAssets } = require('./lib/assets.js');
const { createApp } = require('./lib/app.js');

let env;
try {
  env = loadEnv(process.env);
} catch (e) {
  console.error(e.message);
  console.error('Copy .env.example to .env and fill it in.');
  process.exit(1);
}

const { hostname, port } = new URL(cfg.PACK.server);
if (hostname !== '127.0.0.1') {
  console.error(`PACK.server must be a 127.0.0.1 address, got ${hostname}`);
  process.exit(1);
}

const server = createApp({ env, cfg, claude: createClaude({ env, cfg }), assets: createAssets() });
server.listen(Number(port), hostname, () => {
  console.log(`UIX pack server on ${cfg.PACK.server} · model ${env.CLAUDE_MODEL} · origin ${env.EXTENSION_ORIGIN}`);
});
