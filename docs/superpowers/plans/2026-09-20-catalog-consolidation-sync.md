# Catalog Consolidation Website Sync — Plan
1. Add permanent RED contract for catalog mappings, tombstone metadata, availability canonicalization, contract versioning and safe errors.
2. Extend public catalog export with explicit consolidation mappings.
3. Join consolidation survivor identity into inactive product export.
4. Canonicalize read-only availability lookups from old SKU to active survivor.
5. Harden availability and inventory-change failures with stable safe codes.
6. Add isolated runtime certification for normal SKU, old SKU, inactive export and mapping payload.
7. Run commerce/catalog contracts, full syntax wall, dependency audit and diff check.
8. Commit, push, open PR, require exact-head Runtime Certification and merge with expected-head protection.
