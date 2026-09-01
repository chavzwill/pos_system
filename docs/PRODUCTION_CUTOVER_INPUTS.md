# Total Tools POS — Production Cutover Inputs

RC7 software and host tooling are certified. This checklist tracks the external infrastructure and company decisions required before production cutover.

## Host

- [ ] Confirm whether Total Tools has an existing Linux-capable server or always-on dedicated machine available for POS hosting.
- [ ] If existing hardware is available, run `scripts/production-host-readiness.sh` and retain the result.
- [ ] Confirm reliable always-on power; document UPS coverage if on-premises.
- [ ] Confirm reliable wired internet/network path.
- [ ] If no suitable existing host exists, perform a short-lived latency/readiness trial of the approved budget VPS candidates before purchasing a monthly plan.

See `docs/PRODUCTION_HOST_SELECTION_2026-09.md`.

## Domain and ingress

- [ ] Select the real production hostname.
- [ ] Confirm who controls DNS for that hostname.
- [ ] Point DNS to the selected production host only during approved cutover preparation.
- [ ] Ensure inbound TCP 80/443 are available to Caddy.
- [ ] Confirm application port 3001 remains private.

## Persistent state

- [ ] Confirm production location for `data/`.
- [ ] Confirm production location for `uploads/`.
- [ ] Confirm available storage capacity and monitoring responsibility.
- [ ] Confirm a single POS application instance will use the local SQLite database.

## Backups and rollback

- [ ] Select an off-machine/off-VM protected backup destination.
- [ ] Verify the cutover operator can write to that destination.
- [ ] Execute the certified stopped-state backup before cutover.
- [ ] Verify SHA-256 checksum.
- [ ] Record the previous code/image SHA.
- [ ] Record the matching pre-cutover `data` + `uploads` archive.

## Environment

- [ ] Create production `.env` from `.env.production.example` without committing secrets.
- [ ] Set the real `POS_DOMAIN`.
- [ ] Confirm local SQLite remains the intended production database architecture.
- [ ] Export the exact approved release SHA for readiness validation.

## Acceptance owners

- [ ] Designate authenticated smoke-test employee account.
- [ ] Designate cashier/POS acceptance representative.
- [ ] Designate Purchasing/Receiving representative.
- [ ] Designate Rentals representative.
- [ ] Designate Repairs/Technician representative.
- [ ] Designate Dispatch representative.
- [ ] Designate Finance/Accounting representative.
- [ ] Schedule the maintenance/cutover window.

## Certified release

Current certified candidate:

`release/total-tools-pos-rc7-2026-08-31`

`9f328931c72df7c0000b46e4c0a3c383b64197ad`

Do not merge or deploy a different SHA as part of the cutover without re-certification.

## Authorization boundary

Completing this checklist does not itself authorize purchasing infrastructure, changing DNS/firewall rules, deploying production, merging `master`, or re-enabling Vercel. Those remain deliberate cutover actions after the relevant inputs above are resolved.
