#!/usr/bin/env node
'use strict';

/**
 * Blind human audit of B1 screenshots.
 *
 *   node bench/audit-server.js [--dir bench/results/audit] [--port 8787] [--rater <name>]
 *   A second person labels with --rater <name> → labels-<name>.json, so the two
 *   raters can be compared (bench/report.js reports inter-rater kappa).
 *   → open http://127.0.0.1:8787
 *
 * Shows baseline vs themed screenshots in a seeded random order WITHOUT the
 * automatic verdict, so labels are independent of the metric. Labels are saved
 * to <dir>/labels.json on every click. Binds to 127.0.0.1 only.
 */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, v, i, all) => (v.startsWith('--') ? [...acc, [v.slice(2), all[i + 1]]] : acc), []),
);
const DIR = path.resolve(args.dir || path.join(__dirname, 'results', 'audit'));
const PORT = Number(args.port || 8787);
const RATER = args.rater ? String(args.rater).toLowerCase() : null;
if (RATER && !/^[a-z0-9_-]{1,32}$/.test(RATER)) {
  console.error('--rater must be letters, digits, _ or -');
  process.exit(2);
}
const LABELS = path.join(DIR, RATER ? `labels-${RATER}.json` : 'labels.json');
const VERDICTS = new Set(['ok', 'broken', 'unsure']);
const SHOT = /^[a-z0-9._-]+\.jpg$/i;

function items() {
  const raw = JSON.parse(fs.readFileSync(path.join(DIR, 'raw.json'), 'utf8'));
  const out = [];
  raw
    .filter((r) => r.status === 'ok')
    .forEach((r) =>
      r.pages
        .filter((p) => p.status === 'ok' && p.shots?.baseline)
        .forEach((p) =>
          p.runs
            .filter((run) => run.shot)
            .forEach((run) =>
              out.push({
                id: `${r.domain}|${p.page}|${run.theme}|${run.mode}`,
                domain: r.domain,
                label: `${run.theme} · Mode ${run.mode}`,
                before: p.shots.baseline,
                after: run.shot,
              }),
            ),
        ),
    );
  // Seeded shuffle so the same theme is not always seen right after its site.
  let a = 20261011;
  const rand = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const readLabels = () => (fs.existsSync(LABELS) ? JSON.parse(fs.readFileSync(LABELS, 'utf8')) : {});

function page() {
  const data = JSON.stringify({ items: items(), labels: readLabels() }).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>UIX 人工比對</title>
<style>
  :root { --bg:#f6f7f9; --surface:#fff; --fg:#111418; --muted:#5b6470; --border:#d9dde3; --ok:#1a7f37; --bad:#c62828; --unsure:#8a6d00; --accent:#1f5fd1; }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) { --bg:#121212; --surface:#1e1f22; --fg:#e6e6e6; --muted:#a0a4ab; --border:#34373c; --ok:#4cc26a; --bad:#ff6b6b; --unsure:#e0b400; --accent:#8ab4f8; }
  }
  :root[data-theme="dark"] { --bg:#121212; --surface:#1e1f22; --fg:#e6e6e6; --muted:#a0a4ab; --border:#34373c; --ok:#4cc26a; --bad:#ff6b6b; --unsure:#e0b400; --accent:#8ab4f8; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.5 system-ui, -apple-system, "PingFang TC", "Noto Sans TC", sans-serif; }
  header { position:sticky; top:0; z-index:1; background:var(--surface); border-bottom:1px solid var(--border); padding:12px 16px; display:flex; flex-wrap:wrap; gap:8px 16px; align-items:center; justify-content:space-between; }
  h1 { font-size:16px; margin:0; }
  .progress { color:var(--muted); font-variant-numeric:tabular-nums; }
  main { max-width:1200px; margin:0 auto; padding:16px; }
  .rule { background:var(--surface); border:1px solid var(--border); border-radius:10px; padding:12px 16px; margin-bottom:16px; color:var(--muted); }
  .rule b { color:var(--fg); }
  .card { background:var(--surface); border:1px solid var(--border); border-radius:10px; padding:12px; margin-bottom:16px; }
  .card.done { opacity:.72; }
  .meta { display:flex; justify-content:space-between; gap:8px; margin-bottom:8px; font-size:13px; color:var(--muted); }
  .pair { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
  @media (max-width:720px) { .pair { grid-template-columns:1fr; } }
  figure { margin:0; }
  figcaption { font-size:12px; color:var(--muted); margin-bottom:4px; }
  img { width:100%; height:auto; border:1px solid var(--border); border-radius:6px; display:block; }
  .actions { display:flex; gap:8px; margin-top:10px; flex-wrap:wrap; }
  button { font:inherit; padding:8px 14px; border-radius:8px; border:1px solid var(--border); background:transparent; color:var(--fg); cursor:pointer; }
  button[aria-pressed="true"][data-v="ok"] { background:var(--ok); border-color:var(--ok); color:#fff; }
  button[aria-pressed="true"][data-v="broken"] { background:var(--bad); border-color:var(--bad); color:#fff; }
  button[aria-pressed="true"][data-v="unsure"] { background:var(--unsure); border-color:var(--unsure); color:#000; }
  button:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
  .saved { font-size:12px; color:var(--muted); }
</style>
</head>
<body>
<header><h1>UIX 人工比對（盲測）</h1><span class="progress" id="progress"></span><span class="saved" id="saved" role="status" aria-live="polite"></span></header>
<main>
  <div class="rule">
    <b>判斷標準：</b>右圖（套用風格後）相較左圖，是否出現
    <b>內容看不到或被遮住、文字難以閱讀、版面明顯錯亂、圖片或按鈕消失</b>？
    出現任一項請選「壞了」。單純「不好看」不算壞。每次點選都會自動儲存。
  </div>
  <div id="list"></div>
</main>
<script>
const DATA = ${data};
const labels = DATA.labels;
const list = document.getElementById('list');
const progress = document.getElementById('progress');
const saved = document.getElementById('saved');
const OPTIONS = [['ok','沒壞'],['broken','壞了'],['unsure','無法判斷']];

function updateProgress() {
  const n = DATA.items.filter((i) => labels[i.id]).length;
  progress.textContent = n + ' / ' + DATA.items.length + ' 已標記';
}

async function save(id, v) {
  labels[id] = v;
  updateProgress();
  try {
    const res = await fetch('/labels', { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify({ id, verdict: v }) });
    saved.textContent = res.ok ? '已儲存' : '儲存失敗';
  } catch { saved.textContent = '儲存失敗'; }
}

DATA.items.forEach((item, idx) => {
  const card = document.createElement('section');
  card.className = 'card' + (labels[item.id] ? ' done' : '');
  const meta = document.createElement('div');
  meta.className = 'meta';
  const left = document.createElement('span'); left.textContent = '#' + (idx + 1) + '  ' + item.domain;
  const right = document.createElement('span'); right.textContent = item.label;
  meta.append(left, right);
  const pair = document.createElement('div');
  pair.className = 'pair';
  [['原網站', item.before], ['套用後', item.after]].forEach(([cap, src]) => {
    const fig = document.createElement('figure');
    const fc = document.createElement('figcaption'); fc.textContent = cap;
    const img = document.createElement('img'); img.loading = 'lazy'; img.src = '/shots/' + encodeURIComponent(src); img.alt = item.domain + ' ' + cap;
    fig.append(fc, img); pair.append(fig);
  });
  const actions = document.createElement('div');
  actions.className = 'actions';
  OPTIONS.forEach(([v, text]) => {
    const b = document.createElement('button');
    b.type = 'button'; b.dataset.v = v; b.textContent = text;
    b.setAttribute('aria-pressed', String(labels[item.id] === v));
    b.addEventListener('click', () => {
      actions.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      card.classList.add('done');
      save(item.id, v);
    });
    actions.append(b);
  });
  card.append(meta, pair, actions);
  list.append(card);
});
updateProgress();
</script>
</body>
</html>`;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(page());
    return;
  }
  if (req.method === 'GET' && url.pathname.startsWith('/shots/')) {
    const name = decodeURIComponent(url.pathname.slice('/shots/'.length));
    const file = path.join(DIR, 'shots', name);
    if (!SHOT.test(name) || !fs.existsSync(file)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'image/jpeg' }).end(fs.readFileSync(file));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/labels') {
    // JSON content-type forces a CORS preflight, which this server never answers.
    if (!String(req.headers['content-type']).startsWith('application/json')) {
      res.writeHead(415).end();
      return;
    }
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 10000) req.destroy();
    });
    req.on('end', () => {
      try {
        const { id, verdict } = JSON.parse(body);
        if (typeof id !== 'string' || id.length > 300 || !VERDICTS.has(verdict)) throw new Error('bad');
        const all = readLabels();
        all[id] = verdict;
        fs.writeFileSync(LABELS, JSON.stringify(all, null, 1));
        res.writeHead(204).end();
      } catch {
        res.writeHead(400).end();
      }
    });
    return;
  }
  res.writeHead(404).end();
});

server.listen(PORT, '127.0.0.1', () => console.log(`audit: http://127.0.0.1:${PORT}  (${items().length} items)`));
