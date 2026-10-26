# Total Tools POS — durable uploads policy

**Status:** implementation candidate dated 2026-10-22; Vercel/Turso live storage still requires audited provider configuration and a recoverability drill.

## Problem this fixes

Some image endpoints previously treated local filesystem writes as success if Cloudinary did not return a result. In a Vercel serverless environment, a file may disappear when the function instance is recycled or not be visible to other instances. A successful response and a permanent DB URL must never point at such a transient artifact.

**Principle:** a durable-write failure is an explicit error, not a fake success.

## Enforced behavior

| Upload type | Cloud provider available | Vercel / serverless provider unavailable | Persistent self-hosted deployment |
|---|---|---|---|
| Product images, bulk images | Store in configured Cloudinary | Return HTTP 503; do not change existing image references | Existing documented local file storage permitted |
| Brand and company logos | Store in configured Cloudinary | Return HTTP 503; preserve old branding | Local file storage permitted |
| Customer ID scans | Cloudinary deliberately refuses private evidence because bearer URLs are not safe | Return HTTP 503 `PRIVATE_STORAGE_UNAVAILABLE`, **never claim a customer ID was saved** | Permission-gated local storage permitted, with replacement ordered after successful DB update |
| PO attachments | Private provider not implemented in existing route | Existing HTTP 503 fail-closed behavior retained | Permission-gated local storage permitted |
| Rental PO attachments | Private provider not implemented in existing route | Existing HTTP 503 fail-closed behavior retained | Permission-gated local storage permitted |
| Rental signatures | Existing behavior may store a bounded data-URI in the durable DB on Vercel | Requires separate security/performance review and a private durable-storage strategy | Local storage fallback remains available |

Production `VERCEL` always requires a durable media provider for the affected image uploads. A self-hosted operator can voluntarily enforce this policy with `POS_REQUIRE_DURABLE_MEDIA=1`. This is a **safety guard**, not the installation of a new storage provider.

## Replacement integrity

- Customer identity evidence is not removed before a durable replacement has been stored and the database reference updated.
- Brand logo replacement no longer deletes the previous file before confirming that a new logo is stored; if Cloudinary reuses a public ID, the overwritten asset is not mistakenly destroyed.
- Company logo replacement does not delete the newly uploaded asset by destroying an old version URL with the same Cloudinary public ID.
- Product images update their database pointer before cleaning up prior files. Cleanup failure is logged, not mistaken for a failed upload or a reason to destroy the new asset.
- Bulk product image errors preserve the specific unavailable-storage failure status rather than reporting only an unexplained server fault.

This change does **not** guarantee atomicity across external cloud uploads and DB commits. Database updates and object storage form a distributed operation, requiring provider-specific orphan cleanup/reconciliation, idempotency keys, versioned replacement IDs and adversarial tests to reach full industrial-grade durability.

## Required completion items

1. **Choose and configure a private durable storage authority** for identity documents, signed agreements and private PO evidence. Do not place them on publicly accessible Cloudinary URLs.
2. Provide authenticated, authorization-checked **upload and download** with audit, tenant/branch boundaries, expiration or object-level access enforcement.
3. Back up Cloudinary/provider objects and database references; perform an isolated restoration with checksum and authorization evidence.
4. Review data URI signature behavior for PII minimization, request limits, backup and performance.
5. Run fresh browser tests with sanitized records for successful uploads, failed uploads and replacement failures. No production transactions should be modified for testing.
6. Protect the `master` GitHub branch with a required exact-head `release-gate`; currently the repo owner must configure this outside the available GitHub actions.

## Certification scope

`node scripts/check-durable-media-contract.js` verifies serverless fail-closed behavior and source invariants without using Cloudinary credentials. GitHub release certification also exercises isolated POS business workflows. A green check does not prove live object-store availability, PII retention correctness, recoverability or end-user acceptance.

See `docs/VERIFIED_UPLOAD_RECOVERY.md` and `docs/COMMERCIAL_GRADE_AUDIT_2026-10-22.md`. No additional infrastructure costs or paid media provider are assumed.
