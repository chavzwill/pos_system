# Stock Planning & Replenishment — Human-Language Design

Status: Approved design direction; implementation-plan gate pending user review.
Date: 2026-09-15
Canonical base: `495190140f30350fa13a1ab59bcb0db6513f7317`
Branch: `feature/stock-planning-human-language`

## Problem

The POS still exposes the staff-facing term “Inventory Intelligence” across Guide Me, purchasing, reporting and the Operations Attention Center. The phrase describes an internal capability, not a job staff are trying to perform. It also appears in workflow keys and tests, so a cosmetic rename would create inconsistent language or break guidance routing.

The product already has useful stock and supplier evidence. Staff should not have to understand product architecture to use it. They need direct answers about shortages, excess stock, transfers, purchasing, supplier choice and money tied up in stock.

## Product decision

The staff-facing capability becomes **Stock Planning & Replenishment**.

Its primary questions are:
- What are we running low on?
- What is overstocked or not moving?
- What should move between branches?
- What should we order, and when?
- Which supplier is the best supported choice?
- What stock is tying up money?

“Inventory intelligence” remains permissible only as an internal technical identifier where changing it would add compatibility risk without staff benefit.
## Architecture and compatibility

Keep existing backend routes, permission identifiers, database names, JavaScript globals, CSS selectors and stable technical feature identifiers unless a change is independently required for correctness. In particular, `/api/inventory-intelligence` may remain an internal API contract.

Introduce one canonical staff-facing task identity for Stock Planning & Replenishment and migrate Guide Me mappings, fallback labels, completion checks and role context together. Compatibility aliases may recognize the legacy task name during the transition, but staff-visible surfaces must render the new wording.

The existing inventory workspace remains the source of stock facts. Stock Planning & Replenishment is the decision-and-action layer over those facts; it must not silently mutate stock. Recommendations continue into governed transfers, purchase requests or other authoritative workflows.

## Staff experience

The workspace must organize evidence by the decision an employee needs to make, not by internal analytics terminology. Suggested sections are **Needs attention**, **Low stock**, **Excess & slow-moving stock**, **Move between branches**, **What to order**, **Supplier choice**, and **Stock value at risk**.

Every recommendation must explain why it is shown using available evidence such as on-hand/available quantity, reservations, demand, open purchase orders, branch imbalance, lead time, supplier reliability and cost. If evidence is unavailable, say so rather than fabricate a recommendation.

Actions must use explicit verbs such as “Create transfer” and “Create purchase request.” Recommendations do not bypass existing approval, purchasing, stock-movement or branch-authority controls.

## Guide Me and navigation

Guide Me must use the new task name and plain-language steps. Completion detection must continue to follow real UI state and authoritative API actions. Role filtering remains permission-aware.

Operations Attention Center, purchasing entry points, reports and other staff-facing launchers must use the same label. Deep links/selectors should continue to resolve the existing workspace safely.
## Reporting and supplier evidence

Reporting must expose stock and supplier outcomes in terms management and purchasing staff understand. Supplier reporting should cover, where authoritative data exists: items sourced from the supplier, purchases/receipts, sales attributable to supplied items, gross profit/profitability, lead-time performance, shortages/overages, damaged/returned goods, fulfillment effectiveness, price history and supplier rating/scorecard evidence.

Supplier ratings must be explainable. A displayed score must identify its evidence window and contributing measures rather than appearing as an unexplained grade. Missing evidence must not be treated as perfect performance.

This slice should reuse existing supplier offer history, purchase orders, receipt discrepancies and scorecard evidence. It must not invent sales attribution where product-to-supplier provenance is ambiguous; reports should state the supported attribution rule.

## Human-language contract

Extend the permanent human-language contract so staff-facing production surfaces cannot regress to “Inventory Intelligence” or equivalent vague labels. Internal route names, source filenames, technical tests and historical documentation are excluded when they are not rendered to staff.

The contract should also reject vague loading/error copy on changed surfaces. Errors must say what staff can do next while centralized handlers keep raw SQL, stack, provider and exception details out of HTTP/UI responses.

## Security and authority

No wording or navigation change alters permissions. Branch scope, purchasing approval, transfer authority, supplier permissions and inventory mutation authority remain enforced server-side. UI hiding is never treated as authorization.

Supplier profitability and cost information must remain limited to roles already authorized for the underlying financial/cost evidence.

## Testing

TDD must prove the legacy staff wording is present before implementation, then prove the new wording across workspace, Guide Me, Operations Attention Center, purchasing and reporting. Existing Guide Me workflow contracts must remain green.
Adversarial coverage must include legacy-name regressions, broken Guide Me routing, unauthorized cost/profit visibility, missing supplier evidence, recommendations that attempt direct stock mutation, and safe error presentation.

Run the relevant runtime suites plus the full repository release wall. Certification follows exact-SHA discipline: feature/PR head must pass before merge, and the resulting integration merge SHA must pass afterward.

## Non-goals

- Renaming stable backend API routes solely for aesthetics.
- Rebuilding the entire inventory subsystem.
- Introducing AI-generated stock decisions without deterministic evidence.
- Bypassing transfer, purchasing or approval workflows.
- Redesigning unrelated POS workspaces.
- Rewriting historical documents merely to erase an old project term.

## Definition of done

Staff encounter **Stock Planning & Replenishment** consistently wherever they enter this workflow. The experience explains stock problems and recommended next actions in plain language, connects to governed operational actions, and exposes useful supplier reporting without overstating evidence.

No changed staff-facing surface exposes the vague legacy term or raw internal errors. Existing permissions and technical compatibility remain intact. Permanent contracts and runtime tests protect the terminology, Guide Me behavior, reporting evidence, security boundaries and non-mutating recommendation invariant.

The exact PR head and resulting canonical integration SHA both pass the complete Runtime Certification wall before this slice is called complete.