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

  fetch('/pos-runtime.json', { credentials: 'same-origin', cache: 'no-store' })
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
