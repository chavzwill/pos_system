(function () {
  'use strict';

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

  async function request(path, options) {
    const init = Object.assign({ credentials: 'same-origin' }, options || {});
    init.method = String(init.method || 'GET').toUpperCase();
    init.headers = Object.assign({ Accept: 'application/json' }, init.headers || {});

    if (init.body && typeof init.body !== 'string' && !(init.body instanceof FormData)) {
      init.headers['Content-Type'] = init.headers['Content-Type'] || 'application/json';
      init.body = JSON.stringify(init.body);
    }

    // Every native mutation gets a durable operation identity. If the browser
    // loses the response after the server committed, a network retry reuses
    // the same key and the server replays the stored outcome instead of
    // charging, receiving, issuing, returning, or dispatching twice.
    if (mutation(init.method)) {
      init.headers['Idempotency-Key'] = init.headers['Idempotency-Key'] || init.idempotencyKey || newIdempotencyKey();
      delete init.idempotencyKey;
    }

    const url = normalizePath(path);
    let response;
    try {
      response = await fetch(url, init);
    } catch (error) {
      if (!mutation(init.method)) throw error;
      // Retry only transport failures, never an HTTP response. The same
      // Idempotency-Key makes this safe even when the first request committed.
      response = await fetch(url, init);
    }

    const contentType = response.headers.get('content-type') || '';
    const payload = contentType.includes('application/json')
      ? await response.json()
      : await response.text();

    if (!response.ok) {
      const error = new Error(
        payload && typeof payload === 'object' && payload.error
          ? payload.error
          : `POS API request failed with ${response.status}`
      );
      error.status = response.status;
      error.payload = payload;
      error.idempotencyReplayed = response.headers.get('Idempotency-Replayed') === 'true';
      throw error;
    }

    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
      Object.defineProperty(payload, '__idempotencyReplayed', {
        value: response.headers.get('Idempotency-Replayed') === 'true',
        enumerable: false,
        configurable: true,
      });
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
  });

  Object.defineProperty(window, 'POS_API', {
    value: api,
    writable: false,
    configurable: false,
  });
})();
