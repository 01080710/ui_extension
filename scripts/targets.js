'use strict';

/**
 * D3 — per-browser manifest transforms. The source manifest.json is the
 * Chrome/Edge manifest; other targets derive from it so nothing drifts.
 */

const FILES = ['manifest.json', '_locales', 'src', 'styles'];

const TARGETS = {
  chrome: (m) => m,
  edge: (m) => m, // Chromium: identical manifest
  firefox: (m) => ({
    ...m,
    // Firefox MV3 has no background service worker; it runs event-page scripts.
    background: { scripts: ['src/config.js', 'src/background.js'] },
    browser_specific_settings: {
      // storage.sync requires a stable add-on id in Firefox.
      gecko: { id: 'uix-style-switcher@local', strict_min_version: '128.0' },
    },
  }),
};

function manifestFor(target, base) {
  const transform = TARGETS[target];
  if (!transform) throw new Error(`unknown target: ${target}`);
  return transform(JSON.parse(JSON.stringify(base)));
}

module.exports = { FILES, TARGETS, manifestFor };
