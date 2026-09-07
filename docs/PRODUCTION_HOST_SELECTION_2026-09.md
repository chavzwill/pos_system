# Total Tools POS — Budget-First Production Host Decision

Date: 2026-09-01

This decision note is intentionally conservative. The POS is for one internal company, so the objective is to minimize recurring infrastructure cost without making the production database, uploads, backups, or employee access unreliable.

## Decision order

### 1. Reuse company-owned hardware first — preferred if it passes RC7 readiness

Monthly hosting cost: effectively $0 beyond electricity, internet and any domain already required.

Use an existing company-owned machine/server only if it can be dedicated to the POS and passes `scripts/production-host-readiness.sh` without failures.

Minimum practical profile:

- Linux
- Docker Engine + Docker Compose
- at least 2 logical CPUs
- approximately 4 GB RAM or more
- SSD storage with at least 20 GB free; 40–80 GB total storage is preferred because operational evidence uploads will grow
- always-on power, preferably UPS-backed
- reliable internet
- persistent `data/` and `uploads/` directories
- off-machine backup destination
- ability to route a real production hostname to Caddy on ports 80/443, while leaving application port 3001 private

Do not reuse an employee workstation that is routinely shut down, moved, unplugged, used for heavy desktop work, or dependent on unstable Wi-Fi.

### 2. Low-cost VPS if no suitable company host exists

Do not buy a server until option 1 has been ruled out by the RC7 readiness gate.

Current reference prices checked on 2026-09-01:

#### Hetzner Europe CX23

- 2 shared vCPU
- 4 GB RAM
- 40 GB disk
- current listed price after the June 2026 adjustment: about USD 6.49/month, excluding IPv4/VAT where applicable

This is the lowest-cost paid candidate that meets the certified minimum CPU/RAM profile. Its main tradeoff for a Jamaica deployment is geographic distance; latency must be tested before committing to it as the primary employee-facing host.

Provider references:

- https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/
- https://www.hetzner.com/cloud/

#### DigitalOcean Basic 4 GiB

- 2 vCPU
- 4 GiB RAM
- 80 GiB SSD
- USD 24/month

This is materially more expensive than the Hetzner Europe entry option, but provides a simple, well-documented production VM profile and more storage headroom. A nearby US region may also provide better interactive latency for Jamaica than a European host; latency should still be measured before purchase.

Provider reference:

- https://www.digitalocean.com/pricing/droplets

### 3. Oracle Always Free — not primary production recommendation

Oracle currently documents Always Free Ampere A1 capacity equivalent to up to 2 OCPUs and 12 GB RAM, which is attractive at $0/month.

However, Oracle also explicitly documents that idle Always Free compute instances may be reclaimed, and that Always Free capacity can be unavailable when a region has no host capacity.

Because this POS is a business system handling cash, stock, rentals, repairs and accounting, the Always Free compute tier should not be the first-choice primary production host. It can be considered later for non-critical testing, a secondary environment, or other workloads where reclamation/capacity risk is acceptable.

Provider reference:

- https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm

## Cost decision

The approved order is therefore:

1. **$0 existing company host**, only if it passes RC7 readiness and can stay reliably online.
2. **Hetzner CX23-class low-cost VPS** if latency tests from Jamaica are acceptable and 40 GB local storage is sufficient initially.
3. **DigitalOcean 4 GiB / 2 vCPU / 80 GiB** if lower operational uncertainty, more storage and likely closer regional access justify roughly USD 24/month.
4. Do not use Oracle Always Free as the primary business POS merely to achieve a $0 bill.

No provider purchase is authorized by this document.

## Required test before any paid VPS purchase

Before approving a paid host, create only a short-lived hourly instance where supported and run:

1. `scripts/production-host-readiness.sh`
2. RC7 Docker + Caddy host profile
3. `scripts/production-host-verify.sh`
4. authenticated read-only smoke test
5. browser interaction from the actual Jamaica office/network
6. confirm acceptable page/API response latency
7. destroy the test instance if the provider is rejected

This prevents committing to a monthly plan before the actual employee network experience is known.

## Backup rule regardless of host

Primary application storage and backup storage must not be the same failure domain.

- If hosted on company hardware, keep a protected backup off that machine.
- If hosted on a VPS, keep a protected backup outside that VM/provider disk.
- Always back up `data/` and `uploads/` together using the certified stopped-state backup procedure before upgrades.

## Current release candidate

The current software candidate remains RC7 at:

`9f328931c72df7c0000b46e4c0a3c383b64197ad`

This host-selection note does not alter RC7 application code and does not authorize merge, deployment, DNS changes or infrastructure spending.
