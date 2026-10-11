/**
 * Background worker:
 *  - relays the browser-level shortcut (chrome.commands) to the active tab's top frame
 *  - C1: on request from our own content script, injects app.css into that frame in
 *    the USER cascade origin, so it beats site !important rules (needs "scripting")
 */
/* global importScripts */
if (typeof importScripts === 'function' && !globalThis.UIX_CONFIG) importScripts('/src/config.js');

(() => {
  'use strict';

  const CFG = globalThis.UIX_CONFIG;

  chrome.commands.onCommand.addListener((command, tab) => {
    if (command !== CFG.COMMANDS.togglePanel || !tab || typeof tab.id !== 'number') return;
    chrome.tabs
      .sendMessage(tab.id, { type: CFG.MESSAGE_TYPES.togglePanel }, { frameId: 0 })
      .catch(() => {}); // no content script on this page (chrome://, Web Store, excluded scheme)
  });

  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (sender.id !== chrome.runtime.id || !msg || msg.type !== CFG.MESSAGE_TYPES.injectUserCss) return;
    if (!sender.tab || typeof sender.tab.id !== 'number' || typeof sender.frameId !== 'number') return;
    chrome.scripting
      .insertCSS({
        target: { tabId: sender.tab.id, frameIds: [sender.frameId] },
        files: CFG.USER_CSS_FILES,
        origin: 'USER',
      })
      .catch(() => {}); // frame went away, or a page the browser does not let us touch
  });
})();
