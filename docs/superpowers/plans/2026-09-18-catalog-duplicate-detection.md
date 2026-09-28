# Catalog Duplicate Detection — Implementation Plan

1. Add a permanent RED contract for duplicate-name and normalized-SKU candidate rules.
2. Extend catalog-integrity authority with deterministic product-group detection.
3. Surface duplicate groups through Catalog Health without mutating any record.
4. Render grouped product evidence in plain staff language.
5. Add runtime fixtures proving valid candidates are detected and unrelated records are not grouped.
6. Run targeted certification, full syntax wall, dependency audit, diff check, commit, push and exact-head PR certification.
