(function () {
  'use strict';

  const state = {
    product: 'Total Tools POS',
    runtime: 'native-pos',
    apiBase: '/api',
    sameOrigin: true,
    ready: false,
    error: null,
  };

  Object.defineProperty(window, 'POS_NATIVE_RUNTIME', {
    value: state,
    writable: false,
    configurable: false,
  });

  function fail(message) {
    state.error = message;
    document.documentElement.dataset.posRuntime = 'error';
    console.error('[POS native runtime]', message);
  }

  function mutation(method) {
    return ['POST', 'PATCH', 'PUT', 'DELETE'].includes(String(method || 'GET').toUpperCase());
  }

  function newKey() {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    return `pos-${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
  }

  // A substantial amount of the mature POS workspace code predates POS_API
  // and still calls window.fetch directly. Protect those mutations too so an
  // ambiguous network failure cannot silently submit checkout, receiving,
  // rental, repair, or dispatch work twice. Existing Idempotency-Key values
  // are preserved, so POS_API and explicit callers remain authoritative.
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async function posProtectedFetch(input, options) {
    const sourceRequest = input instanceof Request ? input : null;
    const init = Object.assign({}, options || {});
    const method = String(init.method || sourceRequest?.method || 'GET').toUpperCase();
    let url;
    try {
      url = new URL(sourceRequest ? sourceRequest.url : String(input), location.href);
    } catch (_) {
      return nativeFetch(input, options);
    }

    const protectedMutation = mutation(method) && url.origin === location.origin && (url.pathname === '/api' || url.pathname.startsWith('/api/'));
    if (!protectedMutation) return nativeFetch(input, options);

    const headers = new Headers(sourceRequest?.headers || undefined);
    new Headers(init.headers || undefined).forEach((value, key) => headers.set(key, value));
    if (!headers.has('Idempotency-Key')) headers.set('Idempotency-Key', newKey());
    init.method = method;
    init.headers = headers;

    const attempt = () => {
      if (sourceRequest) return nativeFetch(new Request(sourceRequest.clone(), init));
      return nativeFetch(input, init);
    };

    try {
      return await attempt();
    } catch (error) {
      // Retry transport ambiguity once with the exact same idempotency key.
      // HTTP errors are normal responses and are never retried here.
      return attempt();
    }
  };

  nativeFetch('/pos-runtime.json', { credentials: 'same-origin', cache: 'no-store' })
    .then((response) => {
      if (!response.ok) throw new Error(`runtime manifest returned ${response.status}`);
      return response.json();
    })
    .then((manifest) => {
      if (!manifest || manifest.runtime !== 'native-pos') {
        throw new Error('unexpected runtime identity');
      }
      if (manifest.frontend !== 'pos-owned' || manifest.server !== 'pos-owned') {
        throw new Error('POS frontend/server ownership boundary is invalid');
      }
      if (manifest.apiBase !== '/api' || manifest.sameOrigin !== true) {
        throw new Error('POS must use its same-origin native API');
      }
      if (manifest.externalCommerceRuntimeRequired !== false) {
        throw new Error('external commerce runtime must not be required to boot POS');
      }
      state.ready = true;
      document.documentElement.dataset.posRuntime = 'native';
      window.dispatchEvent(new CustomEvent('pos:native-runtime-ready', { detail: manifest }));
    })
    .catch((error) => fail(error && error.message ? error.message : String(error)));
})();
