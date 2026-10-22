# Verified Upload Recovery — commercial / industrial POS readiness

**Status:** synthetic restoration implemented; production media recovery **NOT VERIFIED**.

This capability covers a **local `uploads/` directory only**. It is complementary to `docs/VERIFIED_LIBSQL_BACKUP_RECOVERY.md`, not a substitute. The current Total Tools deployment is on **Vercel + Turso**. Vercel's temporary filesystem cannot be treated as durable operational storage; upload routes and image/document references must be inventoried to establish which records reside in Cloudinary, a persistent provider, an on-premises host or a transient path.

## What the tool actually guarantees

- Enumerates local regular upload files recursively; rejects symbolic links, hard links, unsupported filesystem entries and unsafe relative paths.
- Copies into a newly created restricted directory; stores SHA-256, length and relative path for every file. Reports only counts and paths, not the bytes or contents of identity documents.
- Checks the original files again during the copy and compares the destination file checksums. A source that changes during export fails instead of silently certifying mixed content.
- Refuses to overwrite an existing archive or restore destination. Fails closed if no files are present; an empty Vercel `uploads/` tree is **not** evidence that media has been preserved.
- Generates an inventory manifest and separate SHA-256 checksum. Verification checks inventory completeness and hashes; unexpected and missing files are rejected.
- Restores into a new isolated directory only, verifies each restored file and cleans up failed partial operations.
- Protects newly created archive and restore directories with restrictive filesystem permissions. This does **not** encrypt the content.
- The **CI test generates only fake documents and images in an isolated temporary directory**, then verifies export, restore, overwrite refusal, tampering, deletion, path traversal and filesystem link attacks.

**Important limitations:** A local copy does not establish a source-wide transaction or a consistent point in time across database rows and files. Arrange a write freeze or equivalent provider snapshot guarantees for a coherent business recovery point. The manifest checksum is not a digital signature: a party able to edit both manifest and checksum can forge their contents. Protect/export an external checksum or sign using company-managed keys. These files may contain identity documents and signatures; use business-approved encrypted storage, strict retention, role-based access and an offsite backup. The local utility neither reads nor restores Cloudinary or any other object storage provider, and must never be run against live business media on GitHub Actions.

## Controlled operator usage

Run only from an authorized and secured machine/host that actually contains the desired **durable** media, using fresh empty destination paths. Never copy customer files into the public repository, normal CI, issue comments or ChatGPT conversation.

```bash
# Set acknowledgment in a controlled environment, not in source code.
export POS_UPLOAD_RECOVERY_ACKNOWLEDGE=SENSITIVE_MEDIA

# Capture and verify an existing persistent local uploads folder.
node scripts/upload-recovery.js capture /secure/persistent/uploads /encrypted/offsite-staging/media-2026-10-22
node scripts/upload-recovery.js verify /encrypted/offsite-staging/media-2026-10-22

# Restore for an isolated acceptance drill only, never over production.
node scripts/upload-recovery.js restore /encrypted/offsite-staging/media-2026-10-22 /secure/isolated-test/uploads-restored
```

The output directory `media-2026-10-22` contains archived files and `.tt-pos-upload-manifest.json`; `media-2026-10-22.tt-pos-upload-manifest.sha256` is a separate checksum file.

## Required full-company recovery drill

1. Obtain an approved encrypted offsite destination with responsible key custodian and retention schedule; define business RPO/RTO.
2. **Inventory all media authorities** used by POS routes and templates. Confirm whether each upload is durable and recoverable on the active deployment. For provider-held media, use provider-supported export/backup procedures; no local script can recover data never stored locally.
3. Capture a DB snapshot and matching media/provider archives under a documented maintenance or consistent-snapshot boundary. Record source revision, file counts, checksums and capture times.
4. Restore **into a separate isolated environment** with role-restricted access. Verify `libSQL` integrity, permissions and all media checksums before using the restored application.
5. Reconcile a representative sale and refund, a partial PO receipt, branch inventory, rental evidence, customer documentation, repair attachments and open supplier liabilities against the correct recovery cut.
6. Perform approved read-only workflow smoke checks and a security/privacy check; record recovery time, discrepancies, and release owner signoff. Never mutate or discard production records for a drill.

## Synthetic CI

```bash
node scripts/certify-upload-recovery.js
```

This is a useful integrity component, **not** proof of complete production backup, retention, disaster recovery, or industrial-grade certification. Those require verified operational evidence and independent review.
