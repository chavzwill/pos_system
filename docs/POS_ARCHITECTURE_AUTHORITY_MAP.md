# POS Architecture Authority Map

Last updated: 2026-09-10

This map records where authoritative decisions currently appear to live. Anything not independently traced is marked UNVERIFIED.

| Domain | Authoritative state / decision | Current enforcement | State |
|---|---|---|---|
| Employee identity | `employees` + authenticated session | `lib/sessionAuth.js`, employee routes | VALIDATING |
| Employee password | Server-held password hash; self/admin credential lifecycle endpoints | `routes/employees.js`; `lib/sessionAuth.js` elevated reset reauth | VERIFIED on predecessor certified head; final head pending |
| Employee PIN | Server-held hashed PIN | Employee auth + `lib/credentialMutationGuard.js` for mutation boundary | VALIDATING |
| Session validity | Server `sessions` row + active employee + idle/absolute expiry | `lib/sessionAuth.js` | VALIDATING |
| Security permissions | Security-group permissions loaded server-side | `lib/permissions.js`, route guards | IN PROGRESS; complete privilege sweep pending |
| Branch authority | Employee/default/multi-branch server context plus branch integrity middleware | `routes/multi-branch-integrity-guard` and domain routes | UNVERIFIED end-to-end |
| Document identifiers | Shared sequence allocator by table/column/prefix | `lib/nextNumber.js` | VERIFIED allocator; caller inventory pending |
| Product | Product/catalog persistence | Product/catalog routes | UNVERIFIED Gate 2 authority review |
| Price | Product/UOM/promotional/commercial rules | Retail/UOM/promotion guards | UNVERIFIED composite precedence |
| UOM | Product UOM profile and conversion engine | Shared UOM modules and downstream guards | IN PROGRESS |
| Inventory balance | Branch/product inventory and attributable movement records | Inventory movement/reservation/transfer/receiving guards | UNVERIFIED Gate 1/2 |
| Cost / COGS | Cost-layer/accounting modules | Inventory valuation/accounting posting modules | UNVERIFIED Gate 1/2 |
| Customer | Customer records and domain events | Customer/CRM routes | UNVERIFIED Gate 2 |
| Commercial organization | Organization/member records | Commercial-account routes | UNVERIFIED Gate 1/2 |
| Account balance | Financial/accounting sources | Account/settlement/accounting modules | UNVERIFIED Gate 1/2 |
| Sale/order | Transaction/order records | Retail checkout/settlement guards | UNVERIFIED Gate 1 |
| Rental asset | Serialized rental asset/agreement state | Rental routes + loss/custody controls | UNVERIFIED Gate 1/2 |
| Repair item/work order | Work-order/task/repair evidence | Work-order completion, repair parts and QA controls | UNVERIFIED Gate 1/2 |
| Supplier liability | Supplier invoice/payment records | Supplier ledger/loss-prevention/accounting modules | UNVERIFIED Gate 1/2 |
| Security audit | `security_audit_events` | `lib/securityAudit.js` | VERIFIED for password lifecycle; broader coverage IN PROGRESS |
| Release authority | Exact Git SHA + Runtime Certification result | `.github/workflows/runtime-certification.yml` | IMPLEMENTED; protected required status BLOCKED |

## Authority rules

1. Browser/UI state is never authoritative for permission, money, stock, approval, credential, branch or settlement decisions.
2. Provider events may be evidence/input; provider-vs-local authority must be declared per integration before mutation.
3. Derived dashboards/timelines compose authoritative entities/events and must not create competing truth.
4. A successful HTTP response is not sufficient evidence of durable multi-step completion where downstream side effects exist.
5. Unknown precedence or recovery behavior is a Gate 2 defect to resolve, not an assumption.