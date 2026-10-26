# Supplier payment journal review

Finance can open **Accounting Ledger → Review supplier payment journals** to
inspect existing payment sources without invoking the accounting sync.

The read-only endpoint is
`GET /api/accounting-ledger/supplier-payment-journal-review` with optional
`branch_id` and `after` payment-ID cursor. It returns at most 50 payments and a
continuation cursor. Staff need `reports_financial`. Without multi-branch access,
the query is limited to the staff member's default branch; an explicit different
branch is rejected. API-key-only callers are not accepted.

- **Missing journal:** no source journal exists for a positive payment with a
  recognized cash or bank method. Finance can consider the normal accounting
  sync after reviewing the source evidence.
- **Verified posted:** exactly one posted source journal has exactly two lines
  agreeing with the payment: debit AP and credit cash/bank for the same amount.
- **Finance review required:** draft/reversed/duplicate/incomplete/inconsistent
  journal evidence, invalid amount or an unrecognized payment method.

The endpoint only runs SELECT queries. It does not initialize ledger tables,
allocate payments, create journals, alter source records or call the broader
accounting sync. It does not prove that a payment reached a bank: verification
means the internal journal agrees with its recorded payment. Historical bank
reconciliation is still required.

The browser review uses GET requests only, includes page counts and continuation,
and retains the selected branch while paging. The ledger body uses content-sized
grid rows so the review table remains reachable on phones instead of being
compressed behind the trial-balance area.

Validation: three isolated SQLite/Express cases cover classifications, unchanged
records, permission/branch denial, invalid cursors, unknown methods and paging.
Two browser fixture cases cover desktop and phone rendering and GET-only access.
These checks use synthetic records. No live payment or ledger review was run,
and no production financial records were changed by this implementation.
