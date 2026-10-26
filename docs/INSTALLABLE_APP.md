# Total Tools installable web app

The POS stays in its existing codebase and uses the same authenticated server,
branch access and permissions. A progressive web app adds installation and a
standalone launch window without another frontend framework or paid service.
This is the app foundation; individual workspace design improvements continue
in their existing modules.

## Staff experience

- The manifest gives supported browsers the app name, icons and standalone mode.
- Staff can use **Install & app options** in the navigation footer. An available
  browser install prompt opens only after a click. Other browsers show manual
  installation instructions. Installed windows show **App options** instead.
- A connection banner appears when the browser reports offline. It does not
  claim that the server is healthy when the browser reports online.
- A failed app navigation displays a public connection recovery page. It tells
  staff to verify a transaction's status before retrying a submission whose
  outcome is uncertain.
- Worker updates wait until existing windows close. No forced activation or
  automatic reload interrupts an open sale, PO or receiving session.

## Data and update boundaries

`sw.js` stores **only `/offline.html`** in `tt-offline-app-v1`. It does not cache
authenticated HTML, APIs, customer information, documents, stock or financial
data. It does not intercept writes, queue requests or implement background sync.
Existing server rules still control every business transaction.

Only app entry navigations (`/`, `/index.html`, `/app-shell.html`) have a
network-failure fallback. HTTP error responses remain visible; document and API
failures are not replaced with a successful HTML recovery response.

The worker registration bypasses the browser's HTTP cache when checking the
worker script. Express and Vercel both send a no-store policy for `sw.js`.
There is no application asset cache to invalidate. Versioned script URLs and
the existing deployment process continue to control frontend releases.
If the offline page changes, bump the worker's offline cache version so its
installation downloads the replacement. Never add business data to that cache.

## Validation and rollout

`tests/installable-app.spec.js` runs against an actual local HTTP server and
worker. It covers three viewport widths, the install prompt, connection states,
offline recovery, API cache isolation, failed writes, update deferral and icon
dimensions. Browser installation into a real OS app launcher and iOS Safari
must still be checked on physical devices after deployment.

This work builds on the draft PO editor from PR #130. Publish it as a reviewable
change, then release together through the existing production branch and
deployment process. This change does not require a database migration.
