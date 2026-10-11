/**
 * Mode A colour rules for open/closed shadow roots, where app.css cannot reach.
 * Adopted into a shadow root only while a theme is active and removed when it is
 * not, so no html[data-uix-theme] gate is needed. Tokens (--uix-*) inherit across
 * the shadow boundary, so these rules follow whatever theme <html> carries.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.UIX_SHADOW = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const TEXT_INPUTS =
    'input:not([type="checkbox"], [type="radio"], [type="range"], [type="color"], [type="file"], [type="image"], [type="hidden"], [type="button"], [type="submit"], [type="reset"])';

  const css = `
:where(*:not(svg, svg *, img, picture, video, canvas, iframe, object, embed)) {
  background-color: transparent !important;
  color: inherit !important;
  border-color: var(--uix-border) !important;
  text-shadow: none !important;
}
a:any-link {
  color: var(--uix-link) !important;
}
:is(button, [role="button"], input:is([type="button"], [type="reset"])) {
  background-color: var(--uix-surface) !important;
  color: var(--uix-fg) !important;
  border-color: var(--uix-border) !important;
}
:is(button[type="submit"], input[type="submit"]) {
  background-color: var(--uix-accent) !important;
  color: var(--uix-accent-fg) !important;
}
:is(${TEXT_INPUTS}, textarea, select) {
  background-color: var(--uix-bg) !important;
  color: var(--uix-fg) !important;
  border-color: var(--uix-border) !important;
}
:is([role="dialog"], [role="menu"], [role="listbox"], [role="tooltip"], dialog, [popover]) {
  background-color: var(--uix-surface) !important;
  color: var(--uix-fg) !important;
}
`;

  return { css };
});
