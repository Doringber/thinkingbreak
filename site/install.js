// Thinking Break — installation page behaviour.
// Theme toggle and copy button, adapted from the equivalent script in
// Doringber/creativity's install page.

(() => {
  const root = document.documentElement;
  const toggleBtn = document.getElementById('theme-toggle');
  const THEME_KEY = 'thinking-break/theme';

  const systemTheme = () =>
    window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';

  function applyTheme(theme) {
    root.setAttribute('data-theme', theme);
    toggleBtn.textContent = theme === 'dark' ? '☀️' : '🌙';
    toggleBtn.setAttribute(
      'aria-label',
      theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'
    );
    try { localStorage.setItem(THEME_KEY, theme); } catch { /* storage disabled */ }
  }

  const saved = (() => {
    try { return localStorage.getItem(THEME_KEY); } catch { return null; }
  })();
  applyTheme(saved === 'dark' || saved === 'light' ? saved : systemTheme());

  toggleBtn.addEventListener('click', () => {
    applyTheme(root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
  });

  // ── Copy button ─────────────────────────────────────────────────────────
  const btn = document.getElementById('copy-btn');
  const cmdNode = document.querySelector('#cmd-text .cmd-text');

  btn.addEventListener('click', async () => {
    const command = cmdNode.textContent.trim();
    try {
      await navigator.clipboard.writeText(command);
      btn.textContent = 'Copied!';
      btn.classList.add('copied');
      setTimeout(() => {
        btn.textContent = 'Copy';
        btn.classList.remove('copied');
      }, 2000);
    } catch {
      // Clipboard blocked (insecure context, or permission denied): select the
      // command instead so the keyboard shortcut still works.
      const range = document.createRange();
      range.selectNodeContents(cmdNode);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
  });
})();
