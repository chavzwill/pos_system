(() => {
  'use strict';

  const state = { messages: [], busy: false, context: null };
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char]));

  async function api(url, options = {}) {
    const response = await fetch(url, {
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      ...options,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.error || 'Request failed');
      error.code = data.code || null;
      throw error;
    }
    return data;
  }

  function icon() {
    return '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.64 5.64l2.12 2.12M16.24 16.24l2.12 2.12M18.36 5.64l-2.12 2.12M7.76 16.24l-2.12 2.12M12 8.5A3.5 3.5 0 1 1 12 15.5 3.5 3.5 0 0 1 12 8.5Z" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
  }

  function money(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return String(value ?? '');
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: 'JMD',
      maximumFractionDigits: 2,
    }).format(number);
  }

  function productCard(item) {
    return {
      type: 'product',
      title: item.name || 'Product',
      subtitle: [item.brand, item.sku].filter(Boolean).join(' · '),
      source: 'POS',
      facts: [
        item.category ? { label: 'Category', value: item.category } : null,
        item.stock_qty != null ? { label: 'Branch stock', value: String(item.stock_qty) } : null,
        item.price != null ? { label: 'Price', value: money(item.price) } : null,
        item.cost != null ? { label: 'Cost', value: money(item.cost) } : null,
      ].filter(Boolean),
    };
  }

  function assetCard(item) {
    return {
      type: 'rental_asset',
      title: item.asset_number || item.product_name || `Asset ${item.id || ''}`.trim(),
      subtitle: [
        item.product_name,
        item.serial_number ? `Serial ${item.serial_number}` : null,
      ].filter(Boolean).join(' · '),
      source: 'POS',
      facts: [
        item.status ? { label: 'Status', value: item.status } : null,
        item.branch_name ? { label: 'Branch', value: item.branch_name } : null,
        item.sku ? { label: 'SKU', value: item.sku } : null,
        item.acquisition_date ? { label: 'Acquired', value: item.acquisition_date } : null,
        item.acquisition_cost != null ? { label: 'Acquisition cost', value: money(item.acquisition_cost) } : null,
        Array.isArray(item.maintenance) ? { label: 'Maintenance records', value: String(item.maintenance.length) } : null,
        Array.isArray(item.allocations) ? { label: 'Rental allocations', value: String(item.allocations.length) } : null,
      ].filter(Boolean),
    };
  }

  function cardsFrom(answer) {
    const data = answer && answer.data ? answer.data : null;
    if (!data) return [];
    if (Array.isArray(data.items)) {
      return data.items.slice(0, 8).map(item =>
        item.asset_number || item.serial_number ? assetCard(item) : productCard(item)
      );
    }
    if (data.asset_number || data.serial_number || data.id) return [assetCard(data)];
    return [];
  }

  function evidenceFrom(result) {
    return (Array.isArray(result?.evidence) ? result.evidence : []).map(item => ({
      ...item,
      label: item?.title || item?.tool || item?.evidence_source_id || 'source',
      authority: item?.authority || null,
      observedAt: item?.observedAt || item?.observed_at || null,
    }));
  }

  function normalizeResult(result) {
    const answer = result?.answer&&typeof result.answer==='object'
      ? result.answer
      : { text: typeof result?.answer === 'string' ? result.answer : 'No answer returned.', data: null };

    // Keep this explicit so structured v0.4 answers remain the canonical path.
    if (result?.answer&&typeof result.answer==='object' && result.answer.text) {
      answer.text = result.answer.text;
    }

    return {
      kind: result?.kind || 'unknown',
      answer,
      cards: Array.isArray(result?.cards) ? result.cards : cardsFrom(answer),
      evidence: evidenceFrom(result),
      limitations: Array.isArray(result?.limitations) ? result.limitations : [],
    };
  }

  function renderCard(card) {
    return `<article class="tt-ai-card">
      <div class="tt-ai-card__head">
        <span class="tt-ai-card__type">${esc(card.type === 'rental_asset' ? 'Fleet asset' : 'Product')}</span>
        <span class="tt-ai-card__source">${esc(card.source || 'POS')}</span>
      </div>
      <strong>${esc(card.title || 'Record')}</strong>
      ${card.subtitle ? `<p>${esc(card.subtitle)}</p>` : ''}
      <dl>${(card.facts || []).map(fact => `<div><dt>${esc(fact.label)}</dt><dd>${esc(fact.value)}</dd></div>`).join('')}</dl>
    </article>`;
  }

  function renderMessage(message) {
    if (message.role === 'user') {
      return `<div class="tt-ai-msg tt-ai-msg--user"><div>${esc(message.text)}</div></div>`;
    }
    if (message.error) {
      return `<div class="tt-ai-msg tt-ai-msg--assistant"><div class="tt-ai-answer tt-ai-answer--error"><span>Unable to answer</span><p>${esc(message.text)}</p></div></div>`;
    }

    const result = normalizeResult(message.result);
    const answer = result.answer;
    const evidence = result.evidence.map(item => {
      const observed = item.observedAt ? ` · ${esc(item.observedAt)}` : '';
      const records = item.records != null ? ` · ${esc(item.records)} record${Number(item.records) === 1 ? '' : 's'}` : '';
      const authority = item.authority ? ` · ${esc(item.authority)}` : '';
      return `<span>${esc(item.source || 'POS')}${authority} · ${esc(item.label || 'source')}${records}${observed}</span>`;
    }).join('');

    return `<div class="tt-ai-msg tt-ai-msg--assistant">
      <div class="tt-ai-answer">
        <div class="tt-ai-answer__meta">
          <span class="tt-ai-kind tt-ai-kind--${esc(result.kind)}">${esc(result.kind)}</span>
          <span>Evidence-first · Read only</span>
        </div>
        <p class="tt-ai-answer__text">${esc(answer.text)}</p>
        ${result.cards.length ? `<div class="tt-ai-cards">${result.cards.map(renderCard).join('')}</div>` : ''}
        ${evidence ? `<details><summary>Evidence used</summary><div class="tt-ai-evidence">${evidence}</div></details>` : ''}
        ${result.limitations.length ? `<div class="tt-ai-limit">${result.limitations.map(esc).join(' · ')}</div>` : ''}
      </div>
    </div>`;
  }

  function render() {
    const root = document.getElementById('tt-ai-thread');
    if (!root) return;
    root.innerHTML = state.messages.length
      ? state.messages.map(renderMessage).join('')
      : `<div class="tt-ai-empty">
          <div class="tt-ai-empty__mark">${icon()}</div>
          <strong>Ask Total Tools, not the internet.</strong>
          <p>TT AI checks the company records your role is allowed to see and tells you when evidence is missing.</p>
        </div>`;
    root.scrollTop = root.scrollHeight;
  }

  function setComposer(enabled, message = '') {
    const input = document.getElementById('tt-ai-input');
    const button = document.getElementById('tt-ai-send');
    const note = document.getElementById('tt-ai-composer-note');
    if (input) input.disabled = !enabled;
    if (button) button.disabled = !enabled || state.busy;
    if (note && message) note.textContent = message;
  }

  async function send(text) {
    const question = String(text || '').trim();
    if (question.length < 2 || state.busy || state.context?.capabilities?.query===false) return;

    state.messages.push({ role: 'user', text: question });
    state.busy = true;
    render();
    setComposer(true);

    const input = document.getElementById('tt-ai-input');
    const button = document.getElementById('tt-ai-send');
    if (input) input.value = '';
    if (button) {
      button.disabled = true;
      button.textContent = 'Checking…';
    }

    try {
      const result = await api('/api/tt-ai/query',{method:'POST',body:JSON.stringify({message:question})});
      state.messages.push({ role: 'assistant', result });
    } catch (error) {
      let text = error.message;
      if (error.code === 'TT_AI_SERVICE_NOT_CONFIGURED') {
        text = 'TT AI is installed, but this environment has not connected the standalone AI service yet.';
      }
      state.messages.push({ role: 'assistant', error: true, text });
    } finally {
      state.busy = false;
      if (button) button.textContent = 'Ask';
      if (state.context?.capabilities?.query===false) {
        setComposer(false, 'TT AI is installed, but the standalone service is not connected in this environment.');
      } else {
        setComposer(true);
      }
      render();
      input?.focus();
    }
  }

  function close() {
    document.getElementById('tt-ai-workspace')?.remove();
  }

  async function open() {
    close();
    try {
      state.context = await api('/api/tt-ai/context');
    } catch (_) {
      state.context = null;
    }

    const element = document.createElement('section');
    element.id = 'tt-ai-workspace';
    element.className = 'tt-ai-workspace';
    element.innerHTML = `
      <div class="tt-ai-backdrop" data-close></div>
      <div class="tt-ai-panel" role="dialog" aria-modal="true" aria-label="Ask TT AI">
        <header>
          <div class="tt-ai-brand">
            <div class="tt-ai-mark">${icon()}</div>
            <div><span>Total Tools Intelligence</span><h2>Ask TT AI</h2></div>
          </div>
          <div class="tt-ai-head-actions">
            <span class="tt-ai-readonly">Read only</span>
            <button data-close aria-label="Close TT AI">Close</button>
          </div>
        </header>
        <div class="tt-ai-status">
          <span class="tt-ai-dot ${state.context?.capabilities?.query===false ? 'is-offline' : ''}"></span>
          <strong>${state.context?.capabilities?.query===false ? 'Service not connected' : 'Verified company data'}</strong>
          <span>${state.context?.branch_id ? `Branch ${esc(state.context.branch_id)} · ` : ''}No operational changes can be made from this workspace.</span>
        </div>
        <main id="tt-ai-thread"></main>
        <div class="tt-ai-suggestions">
          <button data-q="Find Bosch grinder">Find a product</button>
          <button data-q="Find rental asset GX1-00088">Check a fleet asset</button>
          <button data-q="Do we have generators in stock?">Check branch stock</button>
        </div>
        <form id="tt-ai-form">
          <label for="tt-ai-input">Ask about products, stock, rental machines or exact fleet assets</label>
          <div>
            <textarea id="tt-ai-input" rows="2" maxlength="2000" placeholder="Example: Find rental asset GX1-00088"></textarea>
            <button id="tt-ai-send">Ask</button>
          </div>
          <small id="tt-ai-composer-note">TT AI labels verified and unknown information. It will not invent missing company data.</small>
        </form>
      </div>`;

    document.body.appendChild(element);
    element.querySelectorAll('[data-close]').forEach(node => { node.onclick = close; });
    element.querySelectorAll('[data-q]').forEach(node => {
      node.onclick = () => {
        const input = element.querySelector('#tt-ai-input');
        input.value = node.dataset.q;
        input.focus();
      };
    });
    element.querySelector('#tt-ai-form').onsubmit = event => {
      event.preventDefault();
      send(element.querySelector('#tt-ai-input').value);
    };
    element.querySelector('#tt-ai-input').onkeydown = event => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        send(event.currentTarget.value);
      }
    };

    render();
    if (state.context?.capabilities?.query===false) {
      setComposer(false, 'TT AI is installed, but the standalone service is not connected in this environment.');
    } else {
      setComposer(true);
      element.querySelector('#tt-ai-input').focus();
    }
  }

  function ensureLauncher() {
    const top = document.querySelector('.shell-topbar');
    if (!top || document.getElementById('tt-ai-launcher')) return;
    top.insertAdjacentHTML('beforeend', `<button id='tt-ai-launcher' class="tt-ai-launcher" type="button" aria-label="Ask TT AI">${icon()}<span>Ask TT AI</span></button>`);
    const button = document.getElementById('tt-ai-launcher');
    button.addEventListener('click',open);
  }

  new MutationObserver(ensureLauncher).observe(document.documentElement, {
    subtree: true,
    childList: true,
  });
  ensureLauncher();

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && document.getElementById('tt-ai-workspace')) close();
  });

  window.TotalToolsTTAI = { open, close, ask: send };
})();
