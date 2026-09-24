'use strict';

// Dark/light mode toggle. Fully separate from app.js's simulation logic —
// this only ever touches the data-theme attribute and localStorage. The
// map itself re-themes automatically via a CSS filter (see style.css),
// so no JS hand-off to app.js is needed.
(function () {
  function currentTheme() {
    return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('fc-theme', theme);
    const btn = document.getElementById('themeToggleBtn');
    if (btn) btn.setAttribute('aria-pressed', theme === 'light' ? 'true' : 'false');
  }

  function init() {
    // Sync the map (once it exists) and button state with whatever the
    // head-inline script already set on <html>, then wire up the click.
    applyTheme(currentTheme());
    const btn = document.getElementById('themeToggleBtn');
    if (btn) {
      btn.addEventListener('click', () => applyTheme(currentTheme() === 'light' ? 'dark' : 'light'));
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
