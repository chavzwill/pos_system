# Supplier Returns and Credits Implementation Plan

Goal: complete the correction side of purchasing while preserving independent
receipt, physical-return, credit-document, AP and cash records.
Spec: docs/superpowers/specs/2026-10-24-supplier-returns-credits.md.
Stack: existing Express/libSQL/vanilla browser modules; no new dependencies.

1. Physical module: request/approve/dispatch, transactional quantity/bin/status/
   identity and carrying-value controls, source replay, audit and partial hold
   consumption. Isolated Node tests first. Own return schema and routes.
2. Financial module: immutable captures/posted credits, return/invoice provenance,
   adjusted AP balance helper, payment limits, credit applications and refunds;
   atomic journals and tests. Keep financial and physical mutations separate.
3. Integrate source sync, late landed-cost fail-closed guard, replacement evidence
   and read models; implement the UI using existing purchasing/Finance patterns.
4. Run isolated end-to-end receipt→return→credit→AP/payment/refund flows, existing
   purchasing suites, build and browser checks. Independent whole-branch review.
   Fix material findings and publish exact verified tree as a draft PR.

Initial limits: original branch, eligible retail goods, ≤4-decimal base quantity;
restricted tracked dispositions and landed-component credit reversals are blocked
with explicit explanations. Existing original records are never rewritten.
