# Catalog Duplicate Detection — Design

Date: 2026-09-18
Base: integration/pos-consolidated-2026-09-07 @ 56497a278fd2e51053f2512723f15929b7a6064d

## Goal
Help staff find probable duplicate product records before they distort search, purchasing, stock planning, reporting, or website publishing.

## Safety model
This slice is detection and review only. It never merges, relinks, deletes, retires, edits stock, or rewrites history automatically.

## Detection rules
1. Exact normalized product-name duplicates: active product names match after trimming, case folding, and collapsing repeated whitespace.
2. Probable SKU duplicates: two or more active SKU values are distinct as stored but become the same after case folding and removing common separators such as spaces, hyphens, dots, underscores and slashes.
3. A candidate group must contain at least two distinct product IDs.
4. SKU candidates must contain at least two distinct original SKU strings; identical SKU duplicates are already prevented by the database.
5. Results explain why the records were grouped and tell staff to compare the records rather than assuming they are duplicates.
6. No confidence score is fabricated from insufficient evidence.

## Staff experience
Catalog Health surfaces “Possible duplicate products” and “Possible duplicate SKUs”. Each issue shows the involved products and a plain-language next action: review the products side by side, confirm whether they are genuinely separate, then use governed catalog maintenance. No automatic merge action is exposed in this slice.
