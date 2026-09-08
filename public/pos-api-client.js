(function () {
  'use strict';

  const JOURNAL_KEY = 'tt_pos_pending_mutations_v1';
  const MAX_PENDING_AGE_MS = 24 * 60 * 60 * 1000;
  const nativeFetch = window.fetch.bind(window);

  function normalizePath(path) {
    const value = String(path || '').trim();
    if (!value) throw new Error('POS API path is required');
    if (/^https?:\/\//i.test(value)) throw new Error('POS native API client only accepts same-origin paths');
    if (value === '/api') return value;
    if (value.startsWith('/api/')) return value;
    return `/api/${value.replace(/^\/+/, '')}`;
  }

  function mutation(method) {
    return ['POST', 'PATCH', 'PUT', 'DELETE'].includes(String(method || 'GET').toUpperCase());
  }

  function newIdempotencyKey() {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    return `pos-${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
  }

  function stable(value) {
    if (value === null || value === undefined) return value;
    if (Array.isArray(value)) return value.map(stable);
    if (typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  }

  function bodyIdentity(body) {
    if (body == null) return '';
    if (typeof body === 'string') {
      try { return JSON.stringify(stable(JSON.parse(body))); } catch (_) { return body; }
    }
    if (body instanceof FormData) {
      const parts = [];
      for (const [key, value] of body.entries()) {
        if (value instanceof File) parts.push([key, { file: value.name, size: value.size, type: value.type, modified: value.lastModified }]);
        else parts.push([key, String(value)]);
      }
      return JSON.stringify(parts);
    }
    return JSON.stringify(stable(body));
  }

  function fingerprint(method, url, body) {
    const source = `${method}\n${url}\n${bodyIdentity(body)}`;
    let h = 2166136261;
    for (let i = 0; i < source.length; i += 1) { h ^= source.charCodeAt(i); h = Math.imul(h, 16777619); }
    return `m-${(h >>> 0).toString(16)}-${source.length}`;
  }

  function readJournal() {
    try {
      const raw = JSON.parse(sessionStorage.getItem(JOURNAL_KEY) || '{}');
      const now = Date.now(), out = {};
      for (const [key, entry] of Object.entries(raw && typeof raw === 'object' ? raw : {})) {
        if (entry?.idempotencyKey && Number(entry.createdAt || 0) > now - MAX_PENDING_AGE_MS) out[key] = entry;
      }
      return out;
    } catch (_) { return {}; }
  }

  function writeJournal(journal) { try { sessionStorage.setItem(JOURNAL_KEY, JSON.stringify(journal)); } catch (_) {} }
  function rememberPending(fp, method, url, key) { const journal = readJournal(); journal[fp] = journal[fp] || { idempotencyKey: key, method, url, createdAt: Date.now() }; writeJournal(journal); return journal[fp].idempotencyKey; }
  function pendingKey(fp) { return readJournal()[fp]?.idempotencyKey || null; }
  function clearPending(fp) { const journal = readJournal(); if (journal[fp]) { delete journal[fp]; writeJournal(journal); } }
  function pendingMutations() { return Object.entries(readJournal()).map(([fingerprint, entry]) => ({ fingerprint, ...entry })); }
  function abandonPending(fingerprintValue) { clearPending(String(fingerprintValue || '')); }

  function ambiguousError(error, key, fp) {
    error.ambiguousOutcome = true;
    error.idempotencyKey = key;
    error.mutationFingerprint = fp;
    error.message = `${error.message || 'The server response was lost.'} The operation may already have completed. Retry the same action without changing its values; the POS will reuse its operation identity instead of creating a duplicate.`;
    return error;
  }

  function protectedApiMutation(input, init) {
    if (input instanceof Request) return null;
    const method = String(init?.method || 'GET').toUpperCase();
    if (!mutation(method)) return null;
    let url;
    try { url = new URL(String(input), location.href); } catch (_) { return null; }
    if (url.origin !== location.origin || !url.pathname.startsWith('/api/')) return null;
    if (url.pathname === '/api/employees/login') return null;
    return { method, url: url.pathname + url.search };
  }

  async function inspectAmbiguity(response) {
    if (response.status >= 500) return true;
    if (response.status !== 409) return false;
    try {
      const data = await response.clone().json();
      return ['operation_idempotency_in_progress','operation_idempotency_outcome_unknown','operation_idempotency_receipt_failure'].includes(String(data?.control || ''));
    } catch (_) { return false; }
  }

  async function protectedFetch(input, options) {
    const init = Object.assign({}, options || {});
    const target = protectedApiMutation(input, init);
    if (!target) return nativeFetch(input, options);

    init.headers = new Headers(init.headers || {});
    const fp = fingerprint(target.method, target.url, init.body);
    let key = init.headers.get('Idempotency-Key') || init.headers.get('X-Idempotency-Key') || init.idempotencyKey || pendingKey(fp) || newIdempotencyKey();
    key = rememberPending(fp, target.method, target.url, key);
    init.headers.set('Idempotency-Key', key);
    delete init.idempotencyKey;

    let response;
    try {
      try { response = await nativeFetch(input, init); }
      catch (_) { response = await nativeFetch(input, init); }
    } catch (error) {
      throw ambiguousError(error instanceof Error ? error : new Error(String(error)), key, fp);
    }

    if (response.ok) clearPending(fp);
    else if (!(await inspectAmbiguity(response))) clearPending(fp);
    return response;
  }

  window.fetch = protectedFetch;

  async function request(path, options) {
    const init = Object.assign({ credentials: 'same-origin' }, options || {});
    init.method = String(init.method || 'GET').toUpperCase();
    init.headers = Object.assign({ Accept: 'application/json' }, init.headers || {});
    if (init.body && typeof init.body !== 'string' && !(init.body instanceof FormData)) {
      init.headers['Content-Type'] = init.headers['Content-Type'] || 'application/json';
      init.body = JSON.stringify(init.body);
    }

    const url = normalizePath(path);
    let response;
    try { response = await protectedFetch(url, init); }
    catch (error) { throw error; }

    const contentType = response.headers.get('content-type') || '';
    const payload = contentType.includes('application/json') ? await response.json() : await response.text();
    const control = payload && typeof payload === 'object' ? String(payload.control || '') : '';
    if (!response.ok) {
      const error = new Error(payload && typeof payload === 'object' && payload.error ? payload.error : `POS API request failed with ${response.status}`);
      error.status = response.status;
      error.payload = payload;
      error.idempotencyReplayed = response.headers.get('Idempotency-Replayed') === 'true';
      error.idempotencyKey = response.headers.get('Idempotency-Key') || null;
      if (response.status >= 500 || ['operation_idempotency_in_progress','operation_idempotency_outcome_unknown','operation_idempotency_receipt_failure'].includes(control)) {
        error.ambiguousOutcome = true;
        error.message = `${error.message} The operation may already have completed. Verify the related record before starting a different replacement operation.`;
      }
      throw error;
    }

    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
      Object.defineProperty(payload, '__idempotencyReplayed', { value: response.headers.get('Idempotency-Replayed') === 'true', enumerable: false, configurable: true });
    }
    return payload;
  }

  const api = Object.freeze({
    request,
    get: (path, options) => request(path, Object.assign({}, options || {}, { method: 'GET' })),
    post: (path, body, options) => request(path, Object.assign({}, options || {}, { method: 'POST', body })),
    patch: (path, body, options) => request(path, Object.assign({}, options || {}, { method: 'PATCH', body })),
    put: (path, body, options) => request(path, Object.assign({}, options || {}, { method: 'PUT', body })),
    delete: (path, options) => request(path, Object.assign({}, options || {}, { method: 'DELETE' })),
    pendingMutations,
    abandonPending,
  });

  Object.defineProperty(window, 'POS_API', { value: api, writable: false, configurable: false });
})();
