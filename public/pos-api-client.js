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

  async function request(path, options) {
    const init = Object.assign({ credentials: 'same-origin' }, options || {});
    init.headers = Object.assign({ Accept: 'application/json' }, init.headers || {});

    if (init.body && typeof init.body !== 'string' && !(init.body instanceof FormData)) {
      init.headers['Content-Type'] = init.headers['Content-Type'] || 'application/json';
      init.body = JSON.stringify(init.body);
    }

    const response = await fetch(normalizePath(path), init);
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
      throw error;
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
