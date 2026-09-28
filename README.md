# RetailPOS

## SpendOS integration

For POS-to-SpendOS setup, event contracts, authority boundaries, backfill, operations, and go-live certification, see [`docs/SPENDOS_POS_INTEGRATION_GUIDE.md`](docs/SPENDOS_POS_INTEGRATION_GUIDE.md).

Docker is **not required** for same-machine development. The SpendOS repository can start both services with an isolated POS database, inject the matching local URL/key, run one outbox batch, and verify the link:

```powershell
npm run start:linked-pos -- --pos-dir "C:\path\to\this-pos-checkout"
```

Use Docker only when you specifically need to validate or run the containerized deployment topology.

## Docker deployment

`docker-compose.yml` runs the app against local SQLite by default, persisted via a bind-mounted `./data` volume (`TURSO_DATABASE_URL: file:/app/data/pos.db`). Product images and PO attachments persist separately under `./uploads`. To use Turso instead, remove that env line and set `TURSO_DATABASE_URL` to a real `libsql://` URL plus `TURSO_AUTH_TOKEN`.

```bash
docker compose up -d --build
```

### Resetting the database

Use this when test/demo data needs to be wiped before going live — e.g. after user acceptance testing on the production Docker deployment. Only applies when running on **local SQLite** (the default); if `TURSO_DATABASE_URL` is set to a real `libsql://` URL, delete/recreate the tables via the Turso dashboard or CLI instead.

```bash
docker compose down
rm -f ./data/pos.db ./data/pos.db-wal ./data/pos.db-shm
docker compose up -d
```

On next boot, `database.js` recreates the full schema and reseeds defaults, including the built-in security groups. Fresh employee identities are credential-locked. In production, the startup credential preflight requires a strong first-boot administrator password and PIN through `POS_BOOTSTRAP_ADMIN_PASSWORD` and `POS_BOOTSTRAP_ADMIN_PIN`; legacy demo credentials are not accepted.

This wipes all transactions, products, customers, and `settings` table entries (SMTP, Cloudinary, WooCommerce, tax config, etc.) — those will need to be re-entered after reset.

To also clear test product images and PO attachments, remove their contents before restarting:

```bash
rm -rf ./uploads/products/* ./uploads/po-attachments/*
```
