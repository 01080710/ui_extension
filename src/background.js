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

  // ---------------------------------------------------------------- component pack
  //
  // The only place the extension talks to the network: the local server (PACK.server,
  // loopback). Requests carry the user's LOCAL_TOKEN and, because they leave from the
  // worker, the chrome-extension:// Origin the server checks. The API key lives in the
  // server's .env and is never sent here. The existing host_permissions (all http and
  // https hosts) already cover it, so no new permission.

  const PACK = CFG.PACK;
  const MT = CFG.MESSAGE_TYPES;

  // Unfinished packs are kept in storage.session (in memory, cleared when the browser
  // closes). It holds the page capture and the card answers — no secrets.
  try {
    chrome.storage.session.setAccessLevel?.({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' })?.catch?.(() => {});
  } catch {
    /* browser without access levels: the pack simply is not restored */
  }

  class PackError extends Error {
    constructor(code) {
      super(code);
      this.code = code;
    }
  }

  /** Any extension API call resets the worker's 30 s idle timer during a long request. */
  function keepAlive() {
    const id = setInterval(() => chrome.runtime.getPlatformInfo().catch(() => {}), PACK.keepAliveMs);
    return () => clearInterval(id);
  }

  async function packFetch(path, body, timeoutMs) {
    const token = (await chrome.storage.local.get(PACK.storage.token))[PACK.storage.token];
    if (typeof token !== 'string' || !token) throw new PackError('no-token');
    let res;
    try {
      res = await fetch(`${PACK.server}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Local-Token': token },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
        credentials: 'omit',
        redirect: 'error',
        cache: 'no-store',
      });
    } catch (e) {
      throw new PackError(e && e.name === 'TimeoutError' ? 'timeout' : 'server-down');
    }
    if (res.status === 401 || res.status === 403) throw new PackError('unauthorized');
    if (!res.ok) {
      // The server answers errors with { code } only; the UI maps known codes to messages.
      const body = await res.json().catch(() => null);
      throw new PackError(body && typeof body.code === 'string' ? body.code : 'server-error');
    }
    return res;
  }

  /** Newline-delimited JSON events from /generate. */
  async function* ndjson(res) {
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (value) buf += value;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) yield JSON.parse(line);
      }
      if (done) return;
    }
  }

  async function packAnalyze(msg) {
    const res = await packFetch('/analyze', { capture: msg.capture, locale: msg.locale }, PACK.timeoutMs.analyze);
    return { ok: true, analysis: await res.json() };
  }

  async function packGenerate(msg, sender) {
    const { capture, summary, stack, assets, answers, locale } = msg;
    const res = await packFetch('/generate', { capture, summary, stack, assets, answers, locale }, PACK.timeoutMs.generate);
    for await (const evt of ndjson(res)) {
      if (!evt || typeof evt !== 'object') continue;
      if (evt.type === 'phase') {
        chrome.tabs
          .sendMessage(sender.tab.id, { type: MT.packProgress, phase: evt.phase }, { frameId: sender.frameId })
          .catch(() => {}); // tab closed: the response below is dropped as well
      } else if (evt.type === 'need_clarification') {
        return { ok: true, status: 'need_clarification', questions: evt.questions };
      } else if (evt.type === 'done') {
        return { ok: true, status: 'done', filename: evt.filename, zip: evt.zip };
      } else if (evt.type === 'error') {
        throw new PackError(typeof evt.code === 'string' ? evt.code : 'server-error');
      }
    }
    throw new PackError('bad-response');
  }

  const PACK_HANDLERS = { [MT.packAnalyze]: packAnalyze, [MT.packGenerate]: packGenerate };

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    const handler = msg && Object.prototype.hasOwnProperty.call(PACK_HANDLERS, msg.type) ? PACK_HANDLERS[msg.type] : null;
    // Top frame of a tab only: that is where the panel lives.
    if (sender.id !== chrome.runtime.id || !handler || !sender.tab || sender.frameId !== 0) return undefined;
    const stop = keepAlive();
    handler(msg, sender)
      .then(sendResponse, (e) => {
        let code = 'server-error';
        if (e instanceof PackError) code = e.code;
        else if (e instanceof SyntaxError) code = 'bad-response';
        else if (e && e.name === 'TimeoutError') code = 'timeout';
        sendResponse({ ok: false, code });
      })
      .finally(stop);
    return true; // keep the channel open for the async response
  });
})();
