# Refresh location restoration

The shell previously reset to the employee's default domain during every boot, overwriting the history entry. It now stores destination metadata in that entry and restores it after the authenticated profile and summary are ready.

The destination is scoped to employee and default branch and validated against the current permission-filtered command catalog. Sign-out clears the active destination. Unknown or no-longer-authorized workspaces fall back to the normal home screen. Closing a workspace clears its refresh destination.

All workspaces retain their module and supported launch tab. Purchasing additionally records PR/PO tab, status filter, selected document and creation screen. The purchasing register retains applied filters, pagination and selected record. Navigation history contains no form payload, transaction request, credential or operation key; existing protected draft recovery remains responsible for unfinished forms. Restoring a destination issues reads and opens screens; it never submits a business operation.

Verification: seven refresh-focused Chromium tests plus the 17 existing purchasing/register browser checks pass (24 total). Tests cover owner/branch/permission changes, closure, selected PO, register document/search/pagination and creation-screen reopening with zero POSTs. Full npm run vercel-build passes. No production business records created for testing.
