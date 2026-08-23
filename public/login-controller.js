(() => {
  let submitting = false;

  function setError(message) {
    const el = document.getElementById('login-error');
    if (el) el.textContent = message || '';
  }

  function setBusy(button, busy) {
    if (!button) return;
    button.disabled = !!busy;
    button.textContent = busy ? 'Signing In…' : 'Sign In';
  }

  function getApp() {
    // The legacy POS declares `App` as a global lexical binding rather than
    // assigning it to window.App. A later classic script can still reference
    // that binding directly, but `window.App` may be undefined.
    try {
      if (typeof App !== 'undefined' && App) return App;
    } catch (_) {}
    return window.App || null;
  }

  async function login(button) {
    if (submitting) return;

    const userEl = document.getElementById('login-user');
    const passEl = document.getElementById('login-pass');
    const username = userEl?.value?.trim() || '';
    const password = passEl?.value || '';

    setError('');
    if (!username || !password) {
      setError('Please enter username and password.');
      return;
    }

    submitting = true;
    setBusy(button, true);

    try {
      const response = await fetch('/api/employees/login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });

      let payload = {};
      try { payload = await response.json(); } catch (_) {}

      if (!response.ok) {
        throw new Error(payload.error || `Sign in failed (${response.status})`);
      }

      const app = getApp();
      if (!app) {
        throw new Error('POS application failed to initialize. Refresh the page and try again.');
      }

      app.currentUser = payload;
      if (payload.must_change_password && typeof app.showChangePasswordModal === 'function') {
        app.showChangePasswordModal(payload.id, true);
      } else if (typeof app.enterApp === 'function') {
        app.enterApp();
      } else {
        throw new Error('POS application could not enter the authenticated workspace.');
      }
    } catch (error) {
      console.error('POS login failed:', error);
      setError(error?.message || 'Unable to sign in. Please try again.');
    } finally {
      submitting = false;
      setBusy(button, false);
    }
  }

  function bind() {
    const button = document.querySelector('.login-btn');
    const passEl = document.getElementById('login-pass');
    if (!button || button.dataset.hardenedLogin === '1') return;

    button.dataset.hardenedLogin = '1';
    button.removeAttribute('onclick');
    button.setAttribute('type', 'button');
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      login(button);
    }, true);

    if (passEl) {
      passEl.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          login(button);
        }
      }, true);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind, { once: true });
  } else {
    bind();
  }
})();
