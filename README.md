# RetailPOS

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

On next boot, `database.js` recreates the full schema and reseeds defaults — the three built-in security groups (Administrator, Manager, Cashier) and the default admin login `admin` / `123456` (forced password change on first login).

This wipes all transactions, products, customers, and `settings` table entries (SMTP, Cloudinary, WooCommerce, tax config, etc.) — those will need to be re-entered after reset.

To also clear test product images and PO attachments, remove their contents before restarting:

```bash
rm -rf ./uploads/products/* ./uploads/po-attachments/*
```
