# Total Tools POS — Production Host Profile

This profile is intentionally designed for one internal company, not a commercial SaaS fleet.

## Recommended shape

- One Linux server or VM with Docker Engine + Docker Compose.
- One POS application container.
- Local SQLite persisted at `./data/pos.db`.
- Uploaded operational evidence persisted under `./uploads/`.
- Caddy reverse proxy in front of the POS container.
- DNS record for `POS_DOMAIN` pointing at the host.
- TCP 80/443 and UDP 443 allowed through the firewall.
- POS port 3001 is **not** published publicly.
- Protected backup storage must live outside the application checkout directory and preferably off the application disk/host.

## Why Caddy

Caddy keeps the single-company deployment inexpensive and operationally simple. With a real public hostname and reachable ports 80/443 it automatically obtains and renews TLS certificates, avoiding a separate certificate subscription or a hand-maintained Certbot/nginx workflow.

## Minimum host sizing

Start conservatively with:

- 2 vCPU
- 4 GB RAM
- 40–80 GB SSD depending on expected upload/evidence volume
- Linux with current security updates

SQLite and the application are intentionally single-instance. Do not start multiple app replicas against the same local SQLite file.

## Persistent directories

The application checkout should contain or bind to:

- `data/` — SQLite database and sidecars
- `uploads/` — uploaded business evidence

Caddy stores its own certificate/state data in named Docker volumes `caddy_data` and `caddy_config`.

## Environment

Copy `.env.production.example` to `.env` on the host and set:

- `POS_DOMAIN` — production DNS hostname
- `TURSO_AUTH_TOKEN` only if the architecture is deliberately changed to remote Turso

Do not commit `.env`.

## DNS and firewall

Before public TLS can succeed:

1. Create an A/AAAA record for `POS_DOMAIN` pointing to the server.
2. Allow inbound TCP 80 and 443.
3. Allow UDP 443 if HTTP/3 is desired.
4. Do not expose port 3001 to the internet.

## Starting the host profile

Use the certified base Compose file plus the host overlay:

```bash
docker compose -f docker-compose.yml -f docker-compose.host.yml up -d --build
```

Check:

```bash
docker compose -f docker-compose.yml -f docker-compose.host.yml ps
```

The application container should become healthy before Caddy begins serving it.

## Cutover

Use `docs/PRODUCTION_CUTOVER_RUNBOOK.md` and the certified scripts:

- `scripts/production-preflight.sh`
- `scripts/production-backup.sh`
- `scripts/production-restore.sh`
- `scripts/production-smoke.sh`

The release backup must be taken while the application is stopped and must contain `data/` + `uploads/` together.

## Rollback

Rollback means restoring both dimensions of the prior release:

- previous code/image SHA
- matching pre-cutover persisted-state archive

Never roll back code alone after a new schema/data version has been allowed to process real business activity without first reviewing the data state.
