# Catalog Integrity & Cleanup — Implementation Plan

1. Lock invariants with a permanent contract test and RED proof.
2. Add shared catalog-integrity inspection and archive authority.
3. Harden product retirement to fail closed on any physical stock.
4. Add permission-aware Catalog Health API with bounded diagnostics.
5. Harden category create/update against normalized duplicates.
6. Add Catalog Health to the native catalog administration workspace.
7. Add runtime proof for stock-blocked retirement, safe archive, diagnostics, and duplicate category rejection.
8. Register checks in the syntax wall, run full certification, audit dependencies, commit, push, PR, and merge only after exact-head CI passes.
