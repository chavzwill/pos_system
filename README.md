# Total Tools POS

A single-company retail and operations platform with sales, purchasing, inventory, rentals, repairs, dispatch, customer accounts, and related workflows.

## Production state and quality gates

The current hosted POS uses **Vercel** with a persistent remote **Turso/libSQL** database. The repository also contains a separate **Docker + local SQLite** deployment profile; its cutover runbook is a *candidate deployment plan*, not proof that this is the active production host.

- Live hostname: `https://pos-system-rouge-ten.vercel.app/`.
- `vercel.json` disables automatic Git deployment. A GitHub merge alone **does not** update production; a release operator must deploy the exact certified commit and verify the production alias.
- Before production release, run the `Runtime Certification / release-gate` workflow on the exact candidate commit, confirm it succeeded, and review any outstanding P0/P1 risks in `docs/COMMERCIAL_GRADE_AUDIT_2026-10-22.md`.
- Vercel `READY` means a build completed; it does not establish healthy authenticated workflows, database backups, recovery, visual quality, or business acceptance.
- Database persistence, uploaded evidence, backups, restore drills, and maintenance windows depend on the actual selected host. A backup for Docker's `data/` and `uploads/` cannot be assumed to protect a Vercel/Turso installation.

## Security: first-time administrator

**Never use demonstration credentials on a real business deployment.** Production credential initialization is guarded by `scripts/production-credential-preflight.js`; a fresh production administrator cannot authenticate until securely provisioned. Configure the documented bootstrap credentials via secure environment variables and follow the preflight/certification scripts. Do not commit environment values or real customer data.

The automated tests use isolated, synthetic credentials and an isolated test database. Their settings are **not production login instructions**.

## Docker / local SQLite alternative

For a specifically approved self-hosted environment, follow `docs/PRODUCTION_HOST_PROFILE.md`, `docs/PRODUCTION_CUTOVER_INPUTS.md` and `docs/PRODUCTION_CUTOVER_RUNBOOK.md`. `docker-compose.yml` is configured for local SQLite with persistent `data/` and `uploads/` mounts by default.

```bash
docker compose up -d --build
```

**Destructive test-only reset:** Deleting SQLite database files or uploaded records destroys business data and must never be treated as a routine production maintenance action. Use the recovery procedure and a verified backup; do not delete live transactional records merely to reset a demo environment.

## Release evidence and commercial-readiness assessment

- `docs/POS_RELEASE_GATE.md` — code release and exact-commit certification policy.
- `docs/POS_INVARIANT_REGISTRY.md` — financial, inventory, authorization, and operational invariants.
- `docs/POS_BENCHMARK_MATRIX.md` — comparison goals, not claims of superiority.
- `docs/COMMERCIAL_GRADE_AUDIT_2026-10-22.md` — current risk-ranked audit and acceptance checklist.

Do not describe this POS as globally competitive, production-certified, WCAG-conformant, PCI-certified, or business-ready solely because automated tests or a deployment report `READY`. Those claims require independent evidence.
