# POS Quality Evidence Ledger

Last updated: 2026-09-10

States: NOT STARTED / IN PROGRESS / BLOCKED / IMPLEMENTED / VALIDATING / VERIFIED / SURPASS VERIFIED / DEFERRED / RELEASED.

| Capability | Benchmark | State | Evidence | Remaining risk | Next gate |
|---|---|---|---|---|---|
| Historical Sales UOM syntax failure | Build must parse client bundle and preserve monetary zero | VERIFIED | Consolidated `public/sales-workspace.js`; full release gate passed before and after PR #11 merge | None in Gate 0 scope | Gate 1 |
| Self password change | Target=self, current-password proof, policy, revoke sessions, audit | VERIFIED | `routes/employees.js`; hostile credential suite; merged integration Runtime Certification #77 | Broader identity lifecycle remains future audit | Gate 1/2 |
| Admin password reset | Dedicated authority + elevated reauth + revoke target sessions + forced change + audit | VERIFIED | `routes/employees.js`, `lib/sessionAuth.js`; hostile reset suite; Runtime Certification #77 | None in Gate 0 scope | Gate 1 |
| PIN storage/login | Hash at rest; legacy upgrade; controlled PIN authentication | VERIFIED | PIN runtime suite on merged integration Runtime Certification #77 | None in Gate 0 scope | Gate 1 |
| PIN mutation boundary | Self requires old PIN; cross-user requires `security_manage`, reason and actor password reauth; target sessions revoked; audit is transactionally coupled | VERIFIED | Dedicated PIN lifecycle routes + `tests/pin-credential-boundary.spec.js`; Runtime Certification #77 | None in Gate 0 scope | Gate 1 |
| Document number allocation | Concurrent creation cannot allocate duplicate number | VERIFIED | Atomic `document_number_sequences` UPSERT; 24-way concurrency proof; Runtime Certification #77 | Caller/prefix inventory still needs systematic Gate 1 audit | Gate 1 |
| Full runtime release certification | Material changes execute dependency, syntax, business, security and integrity runtime suites | VERIFIED | `.github/workflows/runtime-certification.yml`; exact merged integration SHA `43f9599`; Runtime Certification #77 | Keep extending with new gate-specific adversarial suites | All gates |
| Required protected merge status | Release cannot merge while certification is absent/failing | VERIFIED | Active `pos` ruleset targets authoritative integration branch; strict required `release-gate`; force-push/deletion blocked; no bypass actors | Solo-repo human approval count intentionally 0 | All gates |
| Production dependency baseline | No known moderate-or-higher production dependency advisory at certification time | VERIFIED | `npm audit --omit=dev --audit-level=moderate`; patched `multer`/`nodemailer`; Runtime Certification #77 | Future advisories require ongoing certification | All gates |
| Settings secret-at-rest baseline | Sensitive settings are encrypted under production configuration | VERIFIED | settings encryption certification + live at-rest security suite in Runtime Certification #77 | Key management/rotation remains operational concern | Gate 2 |
| Privileged credential audit baseline | Credential mutations leave attributable immutable evidence without secret values | VERIFIED | password/PIN lifecycle tests in Runtime Certification #77 | Non-credential privileged financial/inventory audit coverage remains Gate 1 | Gate 1 |
| Concurrent double-return prevention | Same sold quantity cannot be returned/restocked twice under simultaneous requests | VALIDATING | Database trigger in `lib/retail-return-invariants.js`; `tests/gate1-return-concurrency.spec.js` | Exact-head Gate 1 runtime result pending | Gate 1 |
| Refund tender ceiling | Refunds cannot exceed the amount originally tendered by each payment method, even across concurrent returns | VALIDATING | Database trigger in `lib/retail-refund-invariants.js`; `tests/gate1-refund-tender-concurrency.spec.js` | Exact-head Gate 1 runtime result pending | Gate 1 |
| Sale settlement replay/idempotency | Retry/duplicate checkout cannot create duplicate sale, money movement or stock decrement | IN PROGRESS | Inventory reservations reduce oversell risk, but request-level sale idempotency is not yet proven | Requires explicit operation identity + replay proof | Gate 1 |
| Money/inventory adversarial certification | No duplicate settlement, over-refund, stock corruption, stale overwrite or UOM drift under replay/concurrency/failure | IN PROGRESS | Gate 1 branch and dedicated concurrency suite established | Remaining checkout, credit note, void, receiving, reservations, transfer, UOM, COGS, rental/repair billing matrix | Gate 1 |

No row may be promoted to `SURPASS VERIFIED` solely because implementation or tests exist.
