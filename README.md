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

## Layout

| Path | Role |
|---|---|
| `src/config.js` | Theme registry, keys, commands, attribute names, storage key, tunables |
| `src/core.js` | Pure logic (sanitising, key resolution, theme application, layer and brand-bar heuristics) |
| `src/content.js` | DOM wiring: storage, panel in closed Shadow DOM, keys, layer/brand scanner, shadow-root styling |
| `src/shadow-style.js` | Mode A colour rules adopted into site shadow roots |
| `src/exporter.js` | Token export builders |
| `src/background.js` | Relays Alt+Shift+U; injects app.css in the USER origin on request (C1, needs `scripting`) |
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
