# Catalog Master-Data Consistency — Plan
1. Add permanent RED contract for naming, SKU whitespace, UOM mismatch, stock/no-price and broken-history checks.
2. Expand Catalog Health evidence query with price and explicit UOM profile data without creating UOM schema as a side effect.
3. Add deterministic, plain-language issues for the new inconsistency classes.
4. Add runtime fixtures proving true positives and non-fabrication when no explicit UOM profile exists.
5. Verify remediation queue automatically groups and prioritizes the new issues.
6. Run focused contracts/runtime, full syntax wall, audit and diff checks.
7. Commit, push, open PR and require exact-head Runtime Certification before merge.
