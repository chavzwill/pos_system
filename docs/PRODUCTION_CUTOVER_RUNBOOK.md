# Total Tools POS — Production Cutover Runbook

This runbook is for the self-hosted Docker + local SQLite production architecture certified for the Total Tools POS.

The application persists operational state in two host directories:

- `data/` — SQLite database and any SQLite sidecar files
- `uploads/` — product, purchasing, rental, repair, delivery/proof and other uploaded evidence

Treat these two directories as one release-state boundary.

## Safety rules

1. Never cut over from a moving development branch.
2. Never back up the release state while employee writes are still occurring.
3. Never restore only `pos.db` while leaving uploads from another point in time.
4. Never restore a backup whose checksum does not verify.
5. Never commit `.env`, credentials, API keys or production secrets.
6. Never roll back only code after a release has mutated production data without reviewing data compatibility.
7. Keep the pre-cutover backup until employee acceptance is complete.

## 1. Host preflight

From the deployment directory:

```bash
bash scripts/production-preflight.sh
```

This checks Docker, Docker Compose, required host utilities, deployment files, persistent directory writeability, Git cleanliness, available disk space and the current application container state. It does not modify the database.

Record the printed `CODE_SHA` in the cutover record.

## 2. Maintenance freeze

Before the release backup:

- announce the maintenance window;
- stop new POS sales, purchasing receipts, rental issue/return, repair completion, dispatch completion and accounting writes;
- confirm all active employees have exited the application;
- record the previously running code/image SHA;
- preserve the current environment/secrets configuration separately.

Then stop the application:

```bash
docker compose stop app
```

Confirm it is stopped:

```bash
docker compose ps
```

## 3. Create the release backup

Choose an off-application backup location when possible, for example a mounted external disk or another protected filesystem:

```bash
BACKUP_ROOT=/path/to/protected/backups bash scripts/production-backup.sh
```

The script refuses to proceed while the app container is running. It archives `data/` and `uploads/` together and creates:

- the `.tar.gz` archive;
- a `.sha256` checksum;
- a `.manifest.txt` containing UTC timestamp and code SHA.

`.env` and source code are deliberately excluded.

Copy the archive, checksum and manifest to the protected backup destination before continuing if `BACKUP_ROOT` was only local temporary storage.

## 4. Deploy the certified release

Check out or otherwise deploy only the approved certified SHA. Do not deploy whatever happens to be at the tip of a development branch.

Re-run:

```bash
bash scripts/production-preflight.sh
```

Build and start:

```bash
docker compose build --pull app
docker compose up -d app
```

## 5. Infrastructure verification

Confirm the container is running:

```bash
docker compose ps
```

Confirm Docker health reaches `healthy`:

```bash
docker inspect --format='{{.State.Health.Status}}' "$(docker compose ps -q app)"
```

Confirm the host database exists:

```bash
test -s data/pos.db
```

Review startup errors if needed:

```bash
docker compose logs --tail=200 app
```

The certified production image runs Node 22, uses the host-mounted `/app/data` and `/app/uploads`, runs PID 1 as the non-root `app` user, and applies WAL plus a 5000 ms busy timeout for configured local `file:` SQLite operation.

## 6. Read-only smoke verification

Public and anonymous-boundary checks can run without credentials:

```bash
POS_BASE_URL=https://your-production-host.example bash scripts/production-smoke.sh
```

For authenticated role-aware checks, use a designated employee account created for cutover verification:

```bash
POS_BASE_URL=https://your-production-host.example \
POS_SMOKE_USERNAME='cutover-user' \
POS_SMOKE_PASSWORD='value-from-secure-secret-source' \
bash scripts/production-smoke.sh
```

Do not store that password in Git, shell history, documentation or the repository `.env` unless the company has explicitly chosen that secrets-management method.

The smoke script performs reads only. It verifies the public shell, anonymous protection, login, and authorized reads across core operational domains. A `403` on a domain is reported as a role-appropriate skip for a smoke user that legitimately lacks that permission.

## 7. Employee acceptance

Before broad use, designated employees should validate their own normal role-specific paths:

- cashier/sales: login, product lookup, branch context, cart/navigation;
- purchasing: supplier/PO/receiving visibility;
- rental: agreement/fleet visibility;
- repairs: work-order/technician visibility;
- dispatch: assigned logistics work and proof workflow visibility;
- accounting/management: authorized finance and operational reporting;
- administrator: user/role/settings/system-health access.

Avoid unnecessary real financial transactions solely to test cutover. Where a transaction must be tested, identify it as an approved controlled test and reverse/reconcile it according to normal business procedure.

## 8. Go/no-go rule

Go live only when all are true:

- exact approved SHA is deployed;
- pre-cutover backup + checksum + manifest exist off the application state path;
- container is healthy;
- persistent SQLite and uploads are confirmed;
- smoke verification is green;
- designated employees accept their role-specific workflows;
- no unresolved integrity, permission, financial or synchronization defect is present.

Otherwise choose **NO-GO** and restore the prior release.

## 9. Rollback

Stop the failed release first:

```bash
docker compose stop app
```

Restore the prior code/image SHA, but do not start it yet.

Restore the matching persisted-state archive only after verifying you selected the correct backup:

```bash
RESTORE_CONFIRM=RESTORE bash scripts/production-restore.sh /path/to/pos-state-YYYYMMDDTHHMMSSZ-SHA.tar.gz
```

The restore script:

- refuses while the app is running;
- requires the explicit confirmation token;
- verifies the checksum before extraction;
- rejects archives containing `.env`, `.git` or `node_modules`;
- requires `data/`, `uploads/` and `data/pos.db`;
- moves the current state into a timestamped local safety directory before replacement;
- automatically puts that state back if extraction/validation fails.

After a successful restore:

```bash
docker compose up -d app
bash scripts/production-smoke.sh
```

Keep the restore safety directory until the recovered system is accepted.

## 10. Cutover record

Record at minimum:

- maintenance window start/end;
- previous production SHA;
- new production SHA;
- backup archive name;
- SHA-256 checksum;
- backup manifest;
- backup storage location;
- operator performing cutover;
- smoke-test result;
- employee acceptance names/roles;
- go/no-go decision;
- rollback details, if applicable.

The goal is that any future operator can determine exactly what code and persisted state were running at any point in a release or rollback.