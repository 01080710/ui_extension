/**
 * Single source of configuration. Nothing else in the extension hard-codes
 * theme ids, attribute names, key bindings, storage keys or UI strings —
 * it reads them here (UI strings live in _locales, referenced by key).
 * Token *values* live in styles/app.css; tests keep the two in sync.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.UIX_CONFIG = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const deepFreeze = (obj) => {
    Object.values(obj).forEach((v) => v && typeof v === 'object' && deepFreeze(v));
    return Object.freeze(obj);
  };

  return deepFreeze({
    STORAGE_KEY: 'uix.settings',

    // Order = order shown in the panel. `msg` is a key in _locales/*/messages.json.
    THEMES: [
      { id: 'minimal', msg: 'themeMinimal' },
      { id: 'dark', msg: 'themeDark' },
      { id: 'material', msg: 'themeMaterial' },
      { id: 'solarized', msg: 'themeSolarized' },
      { id: 'brutalism', msg: 'themeBrutalism' },
      { id: 'custom', msg: 'themeCustom' },
      { id: 'contrast', msg: 'themeContrast' },
      { id: 'sepia', msg: 'themeSepia' },
      { id: 'terminal', msg: 'themeTerminal' },
      { id: 'corporate', msg: 'themeCorporate' },
    ],
    CUSTOM_THEME_ID: 'custom',

    // Every theme block in app.css must declare all of these.
    REQUIRED_TOKENS: [
      '--uix-scheme', '--uix-bg', '--uix-surface', '--uix-fg', '--uix-muted',
      '--uix-border', '--uix-link', '--uix-accent', '--uix-accent-fg', '--uix-focus',
      '--uix-radius', '--uix-shadow', '--uix-ring', '--uix-space',
      '--uix-font', '--uix-leading',
      // Surface for the site's own dark/colour bars (nav, header). Must keep white
      // icons visible, because those icons are often images we cannot recolour.
      '--uix-brand-bg', '--uix-brand-fg',
    ],
    MIN_CONTRAST: 4.5, // WCAG AA, normal text
    MIN_NON_TEXT_CONTRAST: 3, // WCAG 1.4.11, icons and UI parts

    DEFAULT_SETTINGS: {
      theme: null,
      enhanced: false,
      // Changing fonts reflows text (B1: ~33% of elements moved), so it is opt-in.
      // Enhanced mode implies it.
      fonts: false,
      accent: '#1f5fd1',
      followSystem: false, // D2: use darkTheme while the OS is in dark mode
      darkTheme: 'dark',
      // C4: canvas-rendered apps a colour reset can only break.
      excludedHosts: ['docs.google.com', 'figma.com', 'canva.com', 'miro.com', 'excalidraw.com', 'photopea.com'],
    },
    // chrome.storage.sync allows 8 KB per item; 100 hostnames stays well under it.
    MAX_EXCLUDED_HOSTS: 100,

    // KeyboardEvent.code values: physical keys, so IME / layout do not matter.
    KEYS: { open: ['KeyU'], close: ['KeyI'] },

    // C3: browser-level shortcut (chrome.commands) — works while focus is inside an iframe.
    COMMANDS: { togglePanel: 'toggle-panel' },
    MESSAGE_TYPES: {
      togglePanel: 'uix:toggle-panel',
      injectUserCss: 'uix:inject-user-css',
      packAnalyze: 'uix:pack-analyze',
      packGenerate: 'uix:pack-generate',
      packProgress: 'uix:pack-progress',
    },

    // C1: the same stylesheet re-injected in the USER cascade origin. User !important
    // beats every author !important, inline included (cascade analysis: 10 of 12
    // pages that kept site colours were lost to site !important rules).
    USER_CSS_FILES: ['styles/app.css'],

    ATTR: {
      theme: 'data-uix-theme',
      enhanced: 'data-uix-enhanced',
      fonts: 'data-uix-fonts',
      layer: 'data-uix-layer',
      brand: 'data-uix-brand',
    },

    HOST_TAG: 'uix-panel-host',

    LAYER_SCAN: {
      chunkSize: 400, // elements per idle slice
      debounceMs: 200, // batch DOM mutations
      maxViewportCoverage: 0.9, // fixed overlays bigger than this stay transparent
    },

    // Site chrome painted dark/saturated (white icons on a blue nav bar). Measured on
    // the site's ORIGINAL colours, then repainted with --uix-brand-bg instead of cleared.
    BRAND_SCAN: {
      selector:
        'header, nav, footer, [role="banner"], [role="navigation"], [role="contentinfo"], [data-uix-layer]',
      descendantSelector: 'div, ul, section, aside',
      maxDescendants: 40, // per candidate, to bound the cost
      maxLuminance: 0.35, // original background darker than this counts as a brand bar
      minAlpha: 0.6,
    },

    // A1: token export formats. `ext` is appended to `uix-<theme>.`
    EXPORT_FORMATS: [
      { id: 'dtcg', msg: 'exportDtcg', ext: 'tokens.json', mime: 'application/json' },
      { id: 'css', msg: 'exportCss', ext: 'css', mime: 'text/css' },
      { id: 'tailwind', msg: 'exportTailwind', ext: 'tailwind.css', mime: 'text/css' },
    ],

    // Component pack: the visible part of the page → AI analysis → decision cards →
    // a runnable project as .zip. All network traffic goes through the background
    // worker to the local server only (server/ in this repo); the API key never
    // reaches the extension. The server reads these same lists, so ids cannot drift.
    PACK: {
      // Loopback only; the server refuses any other bind. Not 8787: bench/audit-server.js uses it.
      server: 'http://127.0.0.1:8788',
      timeoutMs: { analyze: 120000, generate: 600000 },
      keepAliveMs: 20000, // MV3 worker idles out after 30 s without extension API calls
      sessionMaxAgeMs: 1800000, // an unfinished pack is restored for 30 min
      storage: { last: 'uix.pack.last', token: 'uix.pack.token', session: 'uix.pack.session' },
      defaultZipName: 'uix-pack.zip', // used when the server's filename fails validation
      // Card A. Order = chip order. `msg` is a key in _locales/*/messages.json.
      stack: {
        framework: [
          { id: 'react', msg: 'packFwReact' },
          { id: 'vue', msg: 'packFwVue' },
          { id: 'svelte', msg: 'packFwSvelte' },
          { id: 'vanilla', msg: 'packFwVanilla' },
        ],
        language: [
          { id: 'ts', msg: 'packLangTs' },
          { id: 'js', msg: 'packLangJs' },
        ],
        styling: [
          { id: 'tailwind', msg: 'packStyleTailwind' },
          { id: 'css-modules', msg: 'packStyleCssModules' },
          { id: 'css', msg: 'packStyleCss' },
        ],
      },
      stackFields: [
        { id: 'framework', msg: 'packFieldFramework' },
        { id: 'language', msg: 'packFieldLanguage' },
        { id: 'styling', msg: 'packFieldStyling' },
      ],
      // Card B.
      assetKinds: [
        { id: 'images', msg: 'packAssetImages' },
        { id: 'fonts', msg: 'packAssetFonts' },
        { id: 'icons', msg: 'packAssetIcons' },
      ],
      assetModes: [
        { id: 'bundle', msg: 'packModeBundle' },
        { id: 'placeholder', msg: 'packModePlaceholder' },
        { id: 'link', msg: 'packModeLink' },
      ],
      phases: [
        { id: 'analyze', msg: 'packPhaseAnalyze' },
        { id: 'generate', msg: 'packPhaseGenerate' },
        { id: 'pack', msg: 'packPhasePack' },
      ],
      maxRequiredQuestions: 3,
      maxQuestions: 6, // after need_clarification rounds
      maxOptions: 6,
      maxTextLength: 300, // question / option / summary strings from the server
      capture: {
        viewports: 2, // capture what intersects [scrollY, scrollY + 2 × viewport height)
        maxNodes: 900,
        maxDepth: 40,
        maxText: 160,
        maxIcons: 40,
        maxIconPaths: 12,
        maxIconPathLength: 4000,
        maxIconSize: 64, // px; bigger SVGs are illustrations, kept as boxes
        maxImages: 60,
        maxChars: 400000, // JSON size budget sent to the server
        skipTags: ['script', 'style', 'noscript', 'template', 'iframe', 'object', 'embed', 'link', 'meta', 'head', 'base'],
        attrs: ['role', 'aria-label', 'alt', 'type', 'placeholder', 'title'],
        styles: [
          'display', 'position', 'flex-direction', 'flex-wrap', 'justify-content', 'align-items', 'gap',
          'grid-template-columns', 'width', 'height', 'max-width', 'padding', 'margin',
          'color', 'background-color', 'background-image', 'border', 'border-radius', 'box-shadow',
          'font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing', 'text-align',
          'text-transform', 'text-decoration-line', 'opacity', 'object-fit', 'overflow',
        ],
        // Values that say nothing; dropped to keep the payload small.
        defaultValues: ['none', 'normal', 'auto', '0px', 'rgba(0, 0, 0, 0)', 'static', 'visible', 'start', 'stretch', 'nowrap', 'row', '1'],
        // Analytics / ad hosts: their pixels and frames are never sent. Subdomains match.
        trackerHosts: [
          'google-analytics.com', 'googletagmanager.com', 'doubleclick.net', 'googlesyndication.com',
          'googleadservices.com', 'facebook.net', 'connect.facebook.net', 'hotjar.com', 'clarity.ms',
          'segment.io', 'segment.com', 'mixpanel.com', 'amplitude.com', 'scorecardresearch.com',
          'quantserve.com', 'criteo.com', 'taboola.com', 'outbrain.com', 'adnxs.com', 'bat.bing.com',
          'analytics.tiktok.com','analytics.twitter.com', 'snap.licdn.com', 'px.ads.linkedin.com',
        ],
      },
    },
  });
});
