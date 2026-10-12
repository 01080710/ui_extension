# UIX Style Switcher

Chrome extension (MV3) that re-renders any website with one of ten design-token themes, then exports the chosen theme as design tokens.

- **U** opens the panel, **I** closes it (ignored while typing, during IME composition, or with Ctrl/Cmd/Alt).
- **Alt+Shift+U** toggles the panel from anywhere, including while focus is inside an iframe (rebind at `chrome://extensions/shortcuts`).
- Choose a theme → **套用**. The choice is global and syncs to every open tab.
- Default mode changes colours only. **更換字型** is opt-in because new fonts reflow text.
- **強化模式** (Mode B) also restyles component shape (radius, shadow, table/dialog/tabs) and implies the font change.
- Export the active theme as DTCG JSON, CSS variables or a Tailwind v4 `@theme` block.

## Load

```sh
npm run build          # → dist/chrome, dist/edge, dist/firefox
```

`chrome://extensions` → Developer mode → **Load unpacked** → `dist/chrome`.
Load `dist/`, not the repo root: `node_modules` would be packed in.

## Component pack (local AI server)

1. `cd server && npm install && cp .env.example .env`. Fill in `ANTHROPIC_API_KEY`, a random `LOCAL_TOKEN` (24+ chars), and `EXTENSION_ORIGIN=chrome-extension://<id from chrome://extensions>`.
2. `npm start`. It listens on `127.0.0.1:8788` only and needs the token and this extension's origin on every request.
3. On any page: **U** → **元件樣式包**. The first time, paste `LOCAL_TOKEN` into the card. Its value is stored in `chrome.storage.local`, never in source.
4. Best case is two clicks: **元件樣式包** → **確認並生成** → the `.zip` downloads. Unzip it, open the folder, and run `npm install && npm run dev`.
5. Tests: `npm test` (extension) and `cd server && npm test` (fake Claude, real HTTP and zip).
6. Visible page text and image URLs are sent to Anthropic. Form values, link targets and URL query strings never leave the browser.

## Layout

| Path | Role |
|---|---|
| `src/config.js` | Theme registry, keys, commands, attribute names, storage key, tunables |
| `src/core.js` | Pure logic (sanitising, key resolution, theme application, layer and brand-bar heuristics) |
| `src/content.js` | DOM wiring: storage, panel in closed Shadow DOM, keys, layer/brand scanner, shadow-root styling |
| `src/shadow-style.js` | Mode A colour rules adopted into site shadow roots |
| `src/exporter.js` | Token export builders |
| `src/background.js` | Relays Alt+Shift+U; injects app.css in the USER origin on request (C1, needs `scripting`); the only network caller (component pack → local server) |
| `src/pack-core.js` | Component pack pure logic: sanitising, card defaults, pending count, clarification merge |
| `src/pack-capture.js` | Visible-area DOM → compact JSON (no scripts, hidden nodes, trackers, form values) |
| `src/pack-ui.js` | Decision cards in the panel's shadow root; flow and storage |
| `server/` | Local Node server: auth, DOM re-simplification, Claude calls, path checks, zip |
| `styles/app.css` | Token engine: §0 primitives → §1 theme tokens → §2 T1 → §3 T2 → §4 Mode B (T2–T4) → §5 theme modifiers |
| `bench/` | Real-site coverage benchmark, human audit, cascade analysis |

## Add a theme

1. Add `{ id, msg }` to `THEMES` in `src/config.js` and the label to every `_locales/*/messages.json`.
2. Add an `html[data-uix-theme="<id>"]` block in `styles/app.css` declaring every token in `REQUIRED_TOKENS`.
3. `npm test` — fails if a token is missing, the sets drift apart, any text pair is below WCAG AA, or white icons would vanish on the brand surface.

## Test

```sh
npm test            # unit tests, node --test, no dependencies
npm run test:e2e    # Playwright + Chromium against bench/fixture.html
```

Benchmark and audit workflow: see `docs/coverage-report.md`.
