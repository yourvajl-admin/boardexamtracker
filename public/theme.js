(() => {
  const storageKey = 'boardexamtracker-theme';
  const root = document.documentElement;
  const savedTheme = (() => {
    try {
      const value = localStorage.getItem(storageKey);
      return value === 'dark' || value === 'light' ? value : null;
    } catch {
      return null;
    }
  })();
  const initialTheme = savedTheme || (window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');

  function applyTheme(theme, persist = false) {
    root.dataset.theme = theme;
    root.style.colorScheme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#101a29' : '#f5f8fc');
    document.querySelectorAll('.theme-toggle').forEach((button) => {
      const isDark = theme === 'dark';
      button.setAttribute('aria-pressed', String(isDark));
      button.setAttribute('aria-label', `Switch to ${isDark ? 'light' : 'dark'} mode`);
    });
    document.querySelectorAll('.brand-wordmark').forEach((image) => {
      const file = image.closest('.footer-brand') || theme === 'dark' ? 'logo-light.svg' : 'logo.svg';
      image.src = `/${file}?v=20261009-16`;
    });
    if (persist) {
      try { localStorage.setItem(storageKey, theme); } catch { /* Keep the current page theme if storage is unavailable. */ }
    }
  }

  applyTheme(initialTheme);
  const bindControls = () => {
    applyTheme(root.dataset.theme || initialTheme);
    document.querySelectorAll('.theme-toggle').forEach((button) => {
      button.addEventListener('click', () => applyTheme(root.dataset.theme === 'dark' ? 'light' : 'dark', true));
    });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bindControls, { once: true });
  else bindControls();

  window.addEventListener('storage', (event) => {
    if (event.key === storageKey && (event.newValue === 'dark' || event.newValue === 'light')) applyTheme(event.newValue);
  });
})();
