# Catalog Integrity & Cleanup — Design

Date: 2026-09-18
Base: integration/pos-consolidated-2026-09-07 @ c71e291e

## Goal
Give staff a safe, human-readable way to find bad catalog records and retire products without corrupting stock, history, purchasing, sales, rental, service, or website data.

## Core invariants
1. Product retirement never hard-deletes a product row.
2. A product with physical stock anywhere cannot be retired.
3. Historical references are preserved and explained, not erased.
4. Catalog diagnostics are read-only and never mutate inventory.
5. Every cleanup action is permission checked and attributable to the signed-in employee.
6. Staff see plain-language reasons and next actions, not table names or architecture jargon.
7. Category names cannot be duplicated by case/whitespace variants.
8. Catalog health must expose global-vs-branch stock mismatches instead of hiding them.

## Health checks
The first slice reports: inactive products that still have stock, global/branch stock mismatches, uncategorized active products, normal merchandise without a supplier, active online products missing an image, and duplicate category names after normalization.

Each issue returns a stable code, human title, why it matters, exact record identity, severity, and a recommended next action. Diagnostics are bounded and summary counts are returned separately.

## Retirement behavior
The existing product DELETE semantic becomes a governed archive operation. It validates the product, inspects global and branch stock, blocks retirement when quantity exists, leaves historical references untouched, sets active=0 only after validation, and returns stable public error codes.

## UX
Products & Categories gains a Catalog Health view with concise issue cards and exact product/category actions. No vague “inventory intelligence” terminology. Use “Catalog Health”, “Needs attention”, “Why this matters”, and “What to do next”.
