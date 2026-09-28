# Approval Evidence Hardening Design

## Purpose

Make Department Approval history durable at the database boundary so approval evidence cannot be rewritten or erased by ordinary application SQL, accidental cleanup, or deletion of a parent approval request.

## Problem

The current shared approval foundation treats `approval_events` as append-only in application code, but the database does not enforce that invariant. `approval_events.approval_request_id` currently uses `ON DELETE CASCADE`, so deleting an approval request can erase its audit history. Direct `UPDATE` or `DELETE` statements against `approval_events` are also technically possible.

## Design

### Immutable event rows

Install database triggers that reject every `UPDATE` and `DELETE` against `approval_events`. Inserts remain allowed so normal submission, claim, changes-requested, approval, and rejection evidence continues to work.

### Parent deletion protection

Install a database trigger that rejects deletion of an `approval_requests` row whenever approval events exist for it. This provides the required durable-evidence behavior even on existing databases whose `approval_events` foreign-key definition was created earlier with `ON DELETE CASCADE`.

For fresh databases, change the table definition away from cascade semantics as defense in depth. Runtime compatibility must not depend on rebuilding an existing table in place.

### Safe failure behavior

Database-trigger failures remain internal integrity failures. They are not exposed as raw SQL/database text through staff-facing APIs. Existing centralized approval error handling remains the public boundary.

### Compatibility

The hardening must not change staff workflows, approval statuses, Guide Me behavior, manager authorization, Purchasing approval semantics, or existing event insertion paths.

## Required invariants

1. Approval events can be inserted through normal approval workflows.
2. An existing approval event cannot be updated.
3. An existing approval event cannot be deleted.
4. An approval request with evidence cannot be deleted.
5. Failed destructive attempts leave both parent and evidence unchanged.
6. Schema initialization is idempotent.
7. Existing databases receive protection without destructive migration or table rebuild.
8. Fresh databases no longer declare approval-event cascade deletion.
9. No SmartCommerce files are touched.
10. The complete existing release/security/inventory/supplier certification wall must remain green.

## Verification

Add a dedicated Playwright/runtime test that creates a real approval through the public workflow, then directly attempts `UPDATE approval_events`, `DELETE approval_events`, and `DELETE approval_requests`. Each destructive statement must fail and the original rows must remain intact. Add a static contract that requires the protection triggers and rejects `ON DELETE CASCADE` from the fresh approval-event schema definition.
