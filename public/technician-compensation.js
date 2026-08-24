(() => {
  'use strict';

  const API = '/api/technician-compensation';
  const state = {
    allowed: false,
    open: false,
    summary: null,
    date: new Date().toISOString().slice(0, 10),
    working: false,
  };

  const money = n => new Intl.NumberFormat('en-JM', {
    style: 'currency',
    currency: 'JMD',
    maximumFractionDigits: 2,
  }).format(Number(n) || 0);

  const esc = s => String(s ?? '').replace(/[&<>'"]/g, c => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;',
  }[c]));

  async function request(path, init = {}) {
    const response = await fetch(API + path, {
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers || {}),
      },
      ...init,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || 'Technician compensation is unavailable');
    return payload;
  }

  function authenticatedShellVisible() {
    const login = document.getElementById('login-screen');
    const main = document.getElementById('main');
    if (!login || !main) return false;
    return getComputedStyle(login).display === 'none' && getComputedStyle(main).display !== 'none';
  }

  async function load() {
    if (!state.open) return;
    state.working = true;
    render();
    try {
      state.summary = await request('/summary?date=' + encodeURIComponent(state.date));
    } catch (error) {
      state.summary = { error: error.message, rows: [] };
    } finally {
      state.working = false;
      render();
    }
  }

  async function open() {
    if (!authenticatedShellVisible()) return;
    if (state.open) {
      await load();
      return;
    }

    try {
      await request('/period');
      state.allowed = true;
    } catch (error) {
      state.allowed = false;
      console.warn('Technician compensation access denied:', error.message);
      return;
    }

    const existing = document.getElementById('tt-tech-pay-root');
    if (existing) existing.remove();
    const root = document.createElement('div');
    root.id = 'tt-tech-pay-root';
    document.body.appendChild(root);
    state.open = true;
    await load();
  }

  function close() {
    document.getElementById('tt-tech-pay-root')?.remove();
    state.open = false;
  }

  function evidence(row) {
    const labels = {
      time_entries: 'Time',
      task_completion: 'Tasks',
      attendance: 'Attendance',
      overtime_hours: 'OT',
      qc_first_pass: 'QC',
      comeback_rework: 'Rework',
      safety_events: 'Safety',
    };
    return Object.entries(row.evidence || {}).map(([key, value]) =>
      '<span class="' + (value === 'unavailable' ? 'is-missing' : '') + '" title="' + esc(value) + '">' +
      esc(labels[key] || key) + ': ' + esc(value === 'unavailable' ? 'Unavailable' : 'Verified') + '</span>'
    ).join('');
  }

  function rowMarkup(row) {
    const efficiency = row.efficiency_percent == null
      ? 'Efficiency unavailable'
      : Number(row.efficiency_percent).toFixed(1) + '% allotted/actual';
    return '<tr>' +
      '<td><strong>' + esc(row.first_name) + ' ' + esc(row.last_name) + '</strong><small>' + esc(row.employee_number || '') + '</small></td>' +
      '<td><strong>' + Number(row.worked_hours || 0).toFixed(2) + ' h</strong><small>' + Number(row.worked_minutes || 0).toFixed(1) + ' min</small></td>' +
      '<td><strong>' + esc(row.completed_tasks) + ' completed</strong><small>' + esc(efficiency) + '</small></td>' +
      '<td class="tt-tech-pay__money">' + money(row.hourly_rate) + '</td>' +
      '<td class="tt-tech-pay__money">' + money(row.base_pay) + '</td>' +
      '<td class="tt-tech-pay__money">' + money(row.adjustments_total) + '</td>' +
      '<td class="tt-tech-pay__money">' + money(row.payable_total) + '</td>' +
      '<td><div class="tt-tech-pay__evidence">' + evidence(row) + '</div>' +
      '<div class="tt-tech-pay__actions">' +
      '<button class="tt-action" type="button" data-rate="' + Number(row.employee_id) + '">Set rate</button>' +
      '<button class="tt-action" type="button" data-adjust="' + Number(row.employee_id) + '">Adjustment</button>' +
      '<button class="tt-action is-primary" type="button" data-finalize="' + Number(row.employee_id) + '">Finalize</button>' +
      '</div></td></tr>';
  }

  function render() {
    const root = document.getElementById('tt-tech-pay-root');
    if (!root) return;

    const summary = state.summary;
    const rows = summary?.rows || [];
    let period = 'Select a date to load the applicable period.';
    if (summary?.period) {
      period = '<strong>' + esc(summary.period.start) + '</strong> → <strong>' + esc(summary.period.end) + '</strong> · ' + esc(summary.period.label);
    }

    let notice = '';
    if (state.working) notice = '<div class="tt-tech-pay__notice">Loading verified technician evidence…</div>';
    else if (summary?.error) notice = '<div class="tt-tech-pay__notice is-error">' + esc(summary.error) + '</div>';
    else if (summary?.note) notice = '<div class="tt-tech-pay__notice">' + esc(summary.note) + '</div>';

    let table = '';
    if (!state.working && !summary?.error) {
      table = rows.length
        ? '<div class="tt-tech-pay__table-wrap"><table><thead><tr><th>Technician</th><th>Verified time</th><th>Tasks / efficiency</th><th>Rate</th><th>Base pay</th><th>Adjustments</th><th>Payable</th><th>Evidence / controls</th></tr></thead><tbody>' + rows.map(rowMarkup).join('') + '</tbody></table></div>'
        : '<div class="tt-tech-pay__empty">No completed technician timer evidence exists for this pay period.</div>';
    }

    root.innerHTML = '<div class="tt-tech-pay-overlay" data-pay-close>' +
      '<section class="tt-tech-pay" role="dialog" aria-modal="true" aria-labelledby="tt-tech-pay-title" onclick="event.stopPropagation()">' +
      '<header class="tt-tech-pay__head"><div><span>Total Tools Repairs</span><h2 id="tt-tech-pay-title">Technician Compensation</h2><p>Verified work evidence and controlled pay-period totals.</p></div>' +
      '<button type="button" aria-label="Close technician compensation" data-pay-close>×</button></header>' +
      '<div class="tt-tech-pay__body"><div class="tt-tech-pay__toolbar"><label>Pay-period date<input type="date" id="tt-pay-date" value="' + esc(state.date) + '"></label>' +
      '<div class="tt-tech-pay__period">' + period + '</div></div>' + notice + table +
      '<div id="tt-tech-pay-form" class="tt-tech-pay__form"></div></div></section></div>';
    bind();
  }

  function bind() {
    const root = document.getElementById('tt-tech-pay-root');
    if (!root) return;
    root.querySelectorAll('[data-pay-close]').forEach(element => element.addEventListener('click', close));
    root.querySelector('#tt-pay-date')?.addEventListener('change', event => {
      state.date = event.target.value;
      void load();
    });
    root.querySelectorAll('[data-rate]').forEach(button => button.addEventListener('click', () => showRate(Number(button.dataset.rate))));
    root.querySelectorAll('[data-adjust]').forEach(button => button.addEventListener('click', () => showAdjustment(Number(button.dataset.adjust))));
    root.querySelectorAll('[data-finalize]').forEach(button => button.addEventListener('click', () => void finalize(Number(button.dataset.finalize), button)));
  }

  function targetRow(id) {
    return state.summary?.rows?.find(row => Number(row.employee_id) === Number(id));
  }

  function showRate(id) {
    const row = targetRow(id);
    const form = document.getElementById('tt-tech-pay-form');
    if (!form || !row) return;
    form.classList.add('is-open');
    form.innerHTML = '<h3>Set technician rate · ' + esc(row.first_name) + ' ' + esc(row.last_name) + '</h3>' +
      '<form id="tt-rate-form"><div class="tt-tech-pay__form-grid">' +
      '<label>Hourly rate<input name="hourly_rate" type="number" min="0" step="0.01" value="' + (Number(row.hourly_rate) || 0) + '" required></label>' +
      '<label>Overtime rate<input name="overtime_rate" type="number" min="0" step="0.01" placeholder="Stored for future verified OT evidence"></label>' +
      '<label>Effective from<input name="effective_from" type="date" value="' + esc(state.summary.period.start) + '" required></label></div>' +
      '<label>Change note<textarea name="change_note" placeholder="Why is this rate changing?"></textarea></label>' +
      '<footer><button class="tt-action" type="button" data-form-cancel>Cancel</button><button class="tt-action is-primary" type="submit">Save rate</button></footer></form>';
    form.querySelector('[data-form-cancel]').onclick = () => {
      form.classList.remove('is-open');
      form.innerHTML = '';
    };
    form.querySelector('form').onsubmit = async event => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      try {
        await request('/rates/' + id, { method: 'PUT', body: JSON.stringify(Object.fromEntries(data.entries())) });
        form.classList.remove('is-open');
        await load();
      } catch (error) {
        alert(error.message);
      }
    };
    form.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function showAdjustment(id) {
    const row = targetRow(id);
    const form = document.getElementById('tt-tech-pay-form');
    if (!form || !row) return;
    form.classList.add('is-open');
    form.innerHTML = '<h3>Pay adjustment · ' + esc(row.first_name) + ' ' + esc(row.last_name) + '</h3>' +
      '<form id="tt-adjust-form"><div class="tt-tech-pay__form-grid">' +
      '<label>Type<select name="adjustment_type"><option value="incentive">Incentive</option><option value="correction">Correction</option><option value="deduction">Deduction</option><option value="other">Other</option></select></label>' +
      '<label>Amount<input name="amount" type="number" step="0.01" required></label></div>' +
      '<label>Audit note<textarea name="note" required placeholder="State the evidence/reason for this adjustment."></textarea></label>' +
      '<footer><button class="tt-action" type="button" data-form-cancel>Cancel</button><button class="tt-action is-primary" type="submit">Record adjustment</button></footer></form>';
    form.querySelector('[data-form-cancel]').onclick = () => {
      form.classList.remove('is-open');
      form.innerHTML = '';
    };
    form.querySelector('form').onsubmit = async event => {
      event.preventDefault();
      const data = Object.fromEntries(new FormData(event.currentTarget).entries());
      data.employee_id = id;
      data.period_start = state.summary.period.start;
      data.period_end = state.summary.period.end;
      try {
        await request('/adjustments', { method: 'POST', body: JSON.stringify(data) });
        form.classList.remove('is-open');
        await load();
      } catch (error) {
        alert(error.message);
      }
    };
    form.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  async function finalize(id, button) {
    const row = targetRow(id);
    if (!row) return;
    if (!confirm('Finalize ' + row.first_name + ' ' + row.last_name + ' for ' + state.summary.period.start + ' to ' + state.summary.period.end + '? This freezes the current verified evidence snapshot.')) return;
    button.disabled = true;
    try {
      await request('/finalize/' + id, {
        method: 'POST',
        body: JSON.stringify({ period_start: state.summary.period.start, period_end: state.summary.period.end }),
      });
      alert('Technician pay-period snapshot finalized.');
      await load();
    } catch (error) {
      alert(error.message);
    } finally {
      button.disabled = false;
    }
  }

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && state.open) close();
  });

  new MutationObserver(() => {
    if (state.open && !authenticatedShellVisible()) close();
  }).observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ['style', 'class'] });

  window.TotalToolsTechnicianCompensation = { open, close };
})();
