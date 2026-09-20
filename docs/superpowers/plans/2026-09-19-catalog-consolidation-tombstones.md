# Catalog Consolidation Tombstones — Plan
1. Add permanent RED contract for tombstone immutability, canonical resolution, variation-stock blocking and UI truth.
2. Add shared canonical product resolution / mutation guard.
3. Add database triggers protecting consolidated product active/global stock, branch stock and variation stock.
4. Harden canonical consolidation to reject retiring duplicates with variation stock.
5. Guard product update/delete/stock/variation mutations and bulk imports with stable staff-safe errors.
6. Expose canonical survivor identity on product reads and Catalog Management.
7. Add adversarial runtime certification for reactivation, branch stock, variation stock, import, and canonical resolution.
8. Run full syntax wall, dependency audit, diff check, commit, exact-head PR certification and protected merge.
