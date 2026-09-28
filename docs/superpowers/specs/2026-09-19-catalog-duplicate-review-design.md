# Catalog Duplicate Review Governance — Design
Date: 2026-09-19
Base: integration/pos-consolidated-2026-09-07 @ 48756afd7d057f9ad928412b4de3afc7c878584d

## Goal
Let inventory staff resolve duplicate-candidate noise safely without automatically merging or rewriting products.

## Decisions
- not_duplicate: staff confirmed the candidate group represents genuinely different products; hide that exact candidate fingerprint from Catalog Health.
- confirmed_duplicate: staff confirmed the group represents the same catalog item; keep it visible and escalate it for controlled consolidation.
- needs_more_info: keep the candidate visible while review continues.

## Invariants
1. Review never changes product, stock, transaction, price, supplier, lifecycle, website, or UOM data.
2. Candidate identity includes rule type and sorted exact product IDs.
3. A review applies only to that exact fingerprint; if group membership changes, a fresh review is required.
4. Every change requires authenticated inventory authority and a meaningful reason.
5. Review state uses optimistic versioning so concurrent reviewers cannot silently overwrite each other.
6. Review events are append-only and database-protected.
7. not_duplicate suppresses only the exact reviewed candidate.
8. confirmed_duplicate remains visible with plain-language escalation; it is never auto-merged.
