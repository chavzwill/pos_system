(function () {
  'use strict';
  let installPrompt = null;
  let registration = null;
  let updateReady = false;
  const standalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const connection = document.createElement('div');
  connection.id = 'tt-app-connection';
  connection.setAttribute('role', 'status');
  connection.textContent = 'Offline — reconnect before submitting any changes.';
  document.body.prepend(connection);
  function syncConnection() {
    connection.hidden = navigator.onLine !== false;
    document.body.classList.toggle('tt-app-offline', !connection.hidden);
  }
  syncConnection();
  new ResizeObserver(() => document.documentElement.style.setProperty('--tt-connection-height', connection.getBoundingClientRect().height + 'px')).observe(connection);
  window.addEventListener('online', syncConnection);
  window.addEventListener('offline', syncConnection);

  const dialog = document.createElement('dialog');
  dialog.id = 'tt-app-dialog';
  dialog.setAttribute('aria-labelledby', 'tt-app-dialog-title');
  dialog.innerHTML = '<form method="dialog"><header><span class="shell-mark" aria-hidden="true">TT</span><button aria-label="Close app options">&times;</button></header><h2 id="tt-app-dialog-title">Total Tools app</h2><p>Keep your daily workspace one tap away.</p><div data-install-help><p>Install Total Tools to open it in its own window, using your existing sign-in and branch access.</p><ul><li><strong>iPhone or iPad:</strong> Open in Safari, tap Share, then Add to Home Screen.</li><li><strong>Other devices:</strong> Use Install app or Add to Home screen in your browser menu.</li></ul></div><p data-app-installed hidden>You are using the installed app.</p><button type="button" data-install hidden>Install Total Tools</button><div class="tt-app-update"><p data-update-status role="status">Updates apply after all Total Tools windows are closed. Finish and save your work first.</p><button type="button" data-check-update>Check for updates</button></div><p class="tt-app-note">A live connection is required for sales, stock changes and financial posting.</p></form>';
  document.body.append(dialog);
  const status = dialog.querySelector('[data-update-status]');
  function syncInstall() {
    dialog.querySelector('[data-install]').hidden = !installPrompt || standalone();
    dialog.querySelector('[data-install-help]').hidden = standalone();
    dialog.querySelector('[data-app-installed]').hidden = !standalone();
  }
  function markUpdateReady() {
    updateReady = true;
    status.textContent = 'Update ready. Finish and save your work, then close all Total Tools windows and reopen the app.';
    mountOptions();
  }
  function mountOptions() {
    const footer = document.querySelector('.shell-sidebar footer');
    if (!footer) return;
    let button = footer.querySelector('#tt-app-options');
    if (!button) {
      button = document.createElement('button');
      button.id = 'tt-app-options';
      button.type = 'button';
      button.addEventListener('click', () => { syncInstall(); dialog.showModal(); });
      footer.prepend(button);
    }
    const label = updateReady ? 'App · update ready' : standalone() ? 'App options' : 'Install & app options';
    if (button.textContent !== label) button.textContent = label;
  }
  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    installPrompt = event;
    syncInstall();
  });
  window.addEventListener('appinstalled', () => { installPrompt = null; syncInstall(); mountOptions(); });
  window.matchMedia('(display-mode: standalone)').addEventListener('change', () => { syncInstall(); mountOptions(); });
  dialog.querySelector('[data-install]').addEventListener('click', async () => {
    const prompt = installPrompt;
    if (!prompt) return;
    installPrompt = null;
    syncInstall();
    try { const requestInstall = prompt.prompt.bind(prompt); await requestInstall(); await prompt.userChoice; }
    catch (_) { status.textContent = 'Use your browser menu to install Total Tools.'; }
  });
  dialog.querySelector('[data-check-update]').addEventListener('click', async event => {
    if (!registration) { status.textContent = 'App updates are unavailable here. Try again with a connection in a supported browser.'; return; }
    event.currentTarget.disabled = true;
    status.textContent = 'Checking for updates…';
    try {
      await registration.update();
      if (registration.waiting) markUpdateReady();
      else status.textContent = registration.installing ? 'Downloading app support. Updates apply after all app windows are closed.' : 'No waiting update. You can continue working.';
    } catch (_) { status.textContent = 'Couldn’t check for updates. Check your connection and try again.'; }
    finally { event.currentTarget.disabled = false; }
  });
  new MutationObserver(mountOptions).observe(document.getElementById('shell-root') || document.body, { childList: true, subtree: true });
  mountOptions();
  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' }).then(value => {
      registration = value;
      if (value.waiting) markUpdateReady();
      value.addEventListener('updatefound', () => {
        const worker = value.installing;
        worker?.addEventListener('statechange', () => {
          if (worker.state === 'installed' && value.waiting && navigator.serviceWorker.controller) markUpdateReady();
        });
      });
    }).catch(() => { status.textContent = 'App support couldn’t load. You can keep working online and try again later.'; });
  }
}());
