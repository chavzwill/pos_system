(() => {
  'use strict';

  const state = { stack: [], index: -1, ignore: false };
  const norm = value => String(value || '').replace(/\s+/g, ' ').trim();

  function topbar() { return document.getElementById('topbar'); }
  function titleNode() { return document.getElementById('topbar-title'); }
  function sidebar() { return document.querySelector('#sidebar .sidebar-nav') || document.querySelector('.sidebar-nav'); }

  function navItems() {
    const root = sidebar();
    return root ? [...root.querySelectorAll('.nav-item,[role="button"]')].filter(el => el.closest('#sidebar')) : [];
  }

  function labelFor(el) {
    const copy = norm(el?.textContent);
    return copy || norm(titleNode()?.textContent) || 'Workspace';
  }

  function keyFor(el) {
    if (!el) return '';
    return el.dataset?.guideId || el.id || labelFor(el).toLowerCase();
  }

  function findByEntry(entry) {
    if (!entry) return null;
    const items = navItems();
    return items.find(el => keyFor(el) === entry.key) || items.find(el => labelFor(el) === entry.label) || null;
  }

  function dashboardItem() {
    return navItems().find(el => /dashboard/i.test(labelFor(el))) || null;
  }

  function currentTitle() {
    return norm(titleNode()?.textContent) || 'Dashboard';
  }

  function pushEntry(el) {
    if (state.ignore || !el) return;
    const entry = { key: keyFor(el), label: labelFor(el) };
    const current = state.stack[state.index];
    if (current && current.key === entry.key) return;
    state.stack = state.stack.slice(0, state.index + 1);
    state.stack.push(entry);
    if (state.stack.length > 40) state.stack.shift();
    state.index = state.stack.length - 1;
    syncControls();
  }

  function navigateTo(entry) {
    const el = findByEntry(entry);
    if (!el) return false;
    state.ignore = true;
    try { el.click(); } finally { setTimeout(() => { state.ignore = false; syncControls(); }, 80); }
    return true;
  }

  function goBack() {
    if (state.index <= 0) {
      goHome();
      return;
    }
    const target = state.stack[state.index - 1];
    if (navigateTo(target)) state.index -= 1;
    syncControls();
  }

  function goForward() {
    if (state.index >= state.stack.length - 1) return;
    const target = state.stack[state.index + 1];
    if (navigateTo(target)) state.index += 1;
    syncControls();
  }

  function goHome() {
    const home = dashboardItem();
    if (!home) return;
    state.ignore = true;
    try { home.click(); } finally { setTimeout(() => { state.ignore = false; }, 80); }
    const entry = { key: keyFor(home), label: labelFor(home) };
    state.stack = [entry];
    state.index = 0;
    syncControls();
  }

  function icon(path) {
    return `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="${path}" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  }

  function ensureShell() {
    const bar = topbar();
    const title = titleNode();
    if (!bar || !title) return false;

    let controls = document.getElementById('px-topbar-nav');
    if (!controls) {
      controls = document.createElement('div');
      controls.id = 'px-topbar-nav';
      controls.className = 'px-topbar-nav';
      controls.innerHTML = `
        <button class="px-nav-btn px-nav-back" type="button" aria-label="Go back" title="Back">${icon('M15 18l-6-6 6-6')}</button>
        <button class="px-nav-btn px-nav-forward" type="button" aria-label="Go forward" title="Forward">${icon('M9 18l6-6-6-6')}</button>
        <button class="px-nav-btn px-nav-home" type="button" aria-label="Go to dashboard" title="Dashboard">${icon('M3.5 10.5 12 3l8.5 7.5v9a1.5 1.5 0 0 1-1.5 1.5h-14A1.5 1.5 0 0 1 3.5 19.5v-9Z M9 21v-6h6v6')}</button>`;
      controls.querySelector('.px-nav-back').addEventListener('click', goBack);
      controls.querySelector('.px-nav-forward').addEventListener('click', goForward);
      controls.querySelector('.px-nav-home').addEventListener('click', goHome);
      bar.insertBefore(controls, title);
    }

    let wrap = document.getElementById('px-title-wrap');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.id = 'px-title-wrap';
      wrap.className = 'px-title-wrap';
      bar.insertBefore(wrap, title);
      wrap.appendChild(title);
      const crumb = document.createElement('div');
      crumb.id = 'px-breadcrumb';
      crumb.className = 'px-breadcrumb';
      wrap.appendChild(crumb);
    }

    syncControls();
    return true;
  }

  function syncControls() {
    const title = currentTitle();
    const back = document.querySelector('.px-nav-back');
    const forward = document.querySelector('.px-nav-forward');
    if (back) back.disabled = state.index <= 0;
    if (forward) forward.disabled = state.index < 0 || state.index >= state.stack.length - 1;

    const crumb = document.getElementById('px-breadcrumb');
    if (crumb) {
      const homeText = title.toLowerCase() === 'dashboard' ? '' : '<button type="button" class="px-breadcrumb-home">Dashboard</button><span class="px-breadcrumb-sep">/</span>';
      crumb.innerHTML = `${homeText}<span class="px-breadcrumb-current">${escapeHtml(title)}</span>`;
      crumb.querySelector('.px-breadcrumb-home')?.addEventListener('click', goHome);
    }
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));
  }

  function captureNavClick(event) {
    const item = event.target.closest('#sidebar .nav-item');
    if (!item) return;
    setTimeout(() => {
      pushEntry(item);
      document.querySelectorAll('#sidebar .nav-item').forEach(el => el.classList.toggle('active', el === item || el.classList.contains('active') && keyFor(el) === keyFor(item)));
    }, 20);
  }

  document.addEventListener('click', captureNavClick, true);

  const observer = new MutationObserver(() => {
    if (ensureShell()) syncControls();
  });
  observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['style', 'class'] });

  function boot() {
    if (!ensureShell()) { setTimeout(boot, 120); return; }
    const home = dashboardItem();
    if (home && state.index < 0) {
      state.stack = [{ key: keyFor(home), label: labelFor(home) }];
      state.index = 0;
    }
    syncControls();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  window.TotalToolsNavigation = { back: goBack, forward: goForward, home: goHome };
})();
