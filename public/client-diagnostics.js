(() => {
  'use strict';
  const reports = [];
  function send(kind, detail) {
    const payload = {
      kind,
      detail: String(detail || '').slice(0, 4000),
      href: location.href,
      ua: navigator.userAgent,
      ts: new Date().toISOString(),
    };
    reports.push(payload);
    try {
      fetch('/client-diagnostics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        keepalive: true,
        credentials: 'same-origin',
      }).catch(() => {});
    } catch (_) {}
  }
  window.addEventListener('error', (event) => {
    const detail = [event.message, event.filename, event.lineno, event.colno, event.error && event.error.stack]
      .filter(Boolean).join(' | ');
    send('window.error', detail);
  }, true);
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    send('unhandledrejection', reason && (reason.stack || reason.message || reason));
  });
  window.__POS_CLIENT_DIAGNOSTICS__ = { reports, send };
})();
