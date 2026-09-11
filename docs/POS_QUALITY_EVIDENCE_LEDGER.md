# POS Quality Evidence Ledger

Last updated: 2026-09-10

States: NOT STARTED / IN PROGRESS / BLOCKED / IMPLEMENTED / VALIDATING / VERIFIED / SURPASS VERIFIED / DEFERRED / RELEASED.

| Capability | Benchmark | State | Evidence | Remaining risk | Next gate |
|---|---|---|---|---|---|
| Historical Sales UOM syntax failure | Build must parse client bundle and preserve monetary zero | VERIFIED | Current consolidated `public/sales-workspace.js` uses nullish fallback through `?? 0`; full release gate passed on PR #11 predecessor head | Re-run on final PR head | Gate 0 |
| Self password change | Target=self, current-password proof, policy, revoke sessions, audit | VERIFIED | `routes/employees.js`; `tests/password-reset-security.spec.js`; Runtime Certification run #43 passed | Final-head revalidation | Gate 0 |
| Admin password reset | Dedicated authority + elevated reauth + revoke target sessions + forced change + audit | VERIFIED | `routes/employees.js`, `lib/sessionAuth.js`, password-reset hostile test; Runtime Certification run #43 passed | Final-head revalidation | Gate 0 |
| PIN storage/login | Hash at rest; legacy upgrade; controlled privileged PIN validation | VERIFIED | `lib/pinAuth.js` / employee auth path; `tests/pin-security-runtime.spec.js`; Runtime Certification run #43 passed | Cross-user mutation changes added after run #43 require final validation | Gate 0 |
| PIN mutation boundary | Self requires old PIN; cross-user requires `security_manage`, reason and actor password reauth; target sessions revoked | VALIDATING | `lib/credentialMutationGuard.js`; `tests/pin-credential-boundary.spec.js` | Audit event is post-success rather than atomically coupled to employee update; final runtime proof pending | Gate 0 |
| Document number allocation | Concurrent creation cannot allocate duplicate number | VERIFIED | Atomic `document_number_sequences` UPSERT in `lib/nextNumber.js`; 24-way concurrency test; Runtime Certification run #43 passed | Caller/prefix inventory still needs systematic audit | Gate 0/1 |
| Full runtime release certification | Material changes execute syntax + business + security + integrity runtime suite | IMPLEMENTED | `.github/workflows/runtime-certification.yml` now triggers on material PR/push changes and runs `test:release-gate` plus Gate 0 suite | Must pass on final head and become protected required status | Gate 0 |
| Required protected merge status | Release cannot merge while certification is absent/failing | BLOCKED | Authoritative integration branch currently reports protection disabled | Repository administration rule is not yet enforced | Gate 0 |
| Secrets/config baseline | No unsafe secrets/config behavior | IN PROGRESS | Security-hardening workflows and production preflight tooling exist on integration lineage | Complete explicit secret/config sweep | Gate 0 |
| Privileged mutation audit baseline | Sensitive credential/permission mutations leave attributable evidence | IN PROGRESS | Security audit subsystem and credential audit events exist | Audit remaining privileged mutation surfaces; atomicity varies | Gate 0 |
| Money/inventory adversarial certification | No double settlement/over-refund/stock corruption under replay/concurrency | NOT STARTED | Existing release suite provides partial coverage only | Gate 1 matrix not yet independently certified | Gate 1 |

No row may be promoted to `SURPASS VERIFIED` solely because implementation or tests exist.