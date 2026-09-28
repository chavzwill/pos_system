# Brand Master Data & Website Sync — Design

Date: 2026-09-18
Base: integration/pos-consolidated-2026-09-07 @ c821f5282536e28ed8ebef5ce20b99e60cc05365

## Goal
Make brands first-class governed catalog records that staff can add, edit, review, assign to products, attach a logo to, and publish safely to the website.

## Invariants
1. Brand names are unique after trimming and case folding.
2. Product brand links use stable brand IDs, never free-text copies.
3. Deleting a brand that is still assigned to products is blocked.
4. Logo upload is image-only, size-limited, and replaces old media safely.
5. Website sync exports brand ID, name, description, logo and active state.
6. Product sync includes brand_id and brand_name.
7. Catalog Health reports active products missing a brand.
8. Staff-facing errors use stable codes and plain language.
9. Guide Me can route staff to brand maintenance without performing destructive actions.
