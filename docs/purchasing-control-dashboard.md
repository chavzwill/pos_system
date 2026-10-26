# Purchasing control dashboard

User-approved scope: one operational action queue for deliveries, discrepancies,
invoices, supplier returns and credits, with a next responsible role and a link
into the existing record workflow. This extends the existing purchasing controls
using Express/libSQL and the current browser modules; it adds no dependency,
background job, separate database or paid service.

Open **Purchasing → Purchasing control**. It replaces the old purchasing exceptions
launcher. Each row represents one action on a source line or document, so an order
can have several rows. Counts show actions across the current branch and search,
not purchase orders or the current page. Categories and bounded cursor pages keep
large queues usable. Search treats percent and underscore as literal characters.

- Deliveries include future, overdue and unknown supplier ETAs; closed shortages
  are deducted from outstanding quantities. The latest supplier ETA takes priority.
- Discrepancies use remaining inspection hold evidence.
  Accepted overages are history, and append-only shortage records close quantities; neither creates a permanent approval task.
- Invoice rows distinguish unbilled receipts, captured invoices needing matching,
  matched captures waiting for Finance posting, and posted mismatches/variances.
  Replacement receipt quantities and active captures reserve received quantities.
- Returns distinguish independent approval, dispatch and supplier settlement.
  Active credit captures and replacement links prevent counting the same returned
  quantity again; captured credits remain visible as awaiting Finance posting.
- Finance can see available posted supplier credit after applications and refunds,
  including its exact amount, to review before making a supplier payment.

Responsibility is a role, not an invented employee assignment. Source screens
remain responsible for authorization and business mutations. The dashboard is
read-only, performs no schema initialization or journal posting, and does not
expose Finance amounts to other roles. Access is limited to an assigned branch
unless staff have explicit cross-branch authority. Missing evidence sources show
partial coverage rather than a false all-clear; unavailable credit application or
refund evidence cannot produce a guessed available-credit amount.

Deep links select the original captured/posted invoice, return and credit or focus
the affected PO line. A receipt-line ID cannot be mistaken for an invoice ID.
Saved drafts and uncertain submissions take priority over a new requested target;
existing work is preserved and the user is told to finish or recover it first.

Verification covers isolated query/permission/pagination tests, real target-module
browser tests, and dashboard behavior at phone, tablet and desktop widths. The
existing purchasing and supplier-return suites and source build checks are also
run before publishing a draft pull request. Deployment is a separate release step.
