# Total Tools POS UX Contract

## Product context

- Audience: cashiers, customer-service agents, technicians, rental staff, purchasing staff, dispatchers, inventory staff, finance staff, supervisors and administrators.
- Primary jobs: sell, receive payment, create and progress repairs, issue/return rentals, receive purchasing, move stock, dispatch work, reconcile money, manage customers and administer access.
- Target market: Jamaica-first operational deployment.
- Active locale: English.
- Currency: JMD unless a workflow explicitly supports another currency.
- Accessibility target: WCAG 2.2 AA.

## Business-context sources

| Domain / scope | Authoritative source | Source type |
|---|---|---|
| Permission model | native server RBAC + `routes/multi-branch-integrity-guard.js` | server authorization |
| Retry / duplicate-submit behavior | `routes/operation-idempotency.js` | domain/API invariant |
| Concurrent lifecycle transitions | `routes/lifecycle-concurrency-guard.js` | domain/API invariant |
| Accounting posting | `lib/accounting-posting.js` and accounting routes | financial domain invariant |
| UI visual direction | `DESIGN.md` | design contract |

High-risk actions remain governed by server authorization and lifecycle rules. UI styling must never imply authority the employee does not possess.

## Visual contract

- Project visual source: `DESIGN.md`.
- Runtime canonical presentation layer: `public/total-tools-premium-2026.css` plus approved Total Tools premium workspace extensions loaded after legacy/native workspace styles.
- New screens must use Total Tools semantic roles rather than introduce independent palettes.
- Green = brand/primary success/action. Yellow = signature attention/focus. Red = danger/error. Blue is informational only.
- Supported theme: light operational theme. Dark theme is not implied.

## Canonical UI map

| Capability | Canonical owner | Allowed variants |
|---|---|---|
| App shell | native POS shell | desktop rail / mobile drawer |
| Buttons | Total Tools semantic button treatment | primary / secondary / danger |
| Inputs | workspace native controls + premium token layer | text / number / select / search |
| Tables | domain workspace tables | sticky-header where useful |
| Scrollbars | global Total Tools scrollbar baseline | geometry exceptions only |
| Focus | global yellow focus-visible treatment | none |
| Dialog / drawer | existing app-owned workspace overlays | modal / non-modal drawer where workflow requires |
| Status feedback | existing inline workspace status patterns | success / warning / info / danger |

## Component behavior

- Buttons: clear hover, focus-visible, pressed and disabled states; primary action remains visually dominant within one decision region.
- Inputs: stable height, visible focus, labels retained, entered values preserved on errors.
- Search: immediate clear behavior where available; search field remains visually dominant on catalog/list screens.
- Tables/lists: selected row must have a non-color cue through border, weight, icon or position in addition to tint.
- Destructive controls: separated from safe primary actions and never styled as ordinary brand-green actions.
- Busy state: prevent duplicate mutation submission and preserve control dimensions.

## Dataset navigation

- Dense operational lists retain scrolling within their owning panel where the existing workspace uses internal scroll ownership.
- Tables must not become unbounded document-length surfaces when a contained list/detail layout already exists.
- Empty state explains what is missing and the next available action where one exists.
- Loading/error treatment must preserve the panel footprint and avoid moving primary controls.

## Flow ledger

| Operation | Pending behavior | Success | Failure recovery |
|---|---|---|---|
| Checkout / payment | disable repeat commit, preserve totals | show authoritative receipt/result | retain cart/payment context where safe and explain retry |
| PO receiving | prevent conflicting receive action | refresh PO/inventory evidence | retain PO context and surface server reason |
| Rental issue/return | block conflicting lifecycle action | refresh agreement/status/evidence | preserve agreement and offer valid retry path |
| Repair completion/payment | prevent duplicate transition | refresh work order/accounting state | keep work order visible and surface blocking reason |
| Dispatch handoff | prevent duplicate creation | reveal authoritative dispatch job | retain source document and server error |
| Search/filter | keep current controls stable | replace result set | preserve query and show retry/empty state |

## Navigation and responsive behavior

- Desktop: persistent left rail, sticky topbar, broad operating canvas.
- Tablet: rail becomes drawer where width requires; two-column detail/list surfaces may compress before stacking.
- Phone: full-width work surfaces; primary action remains reachable; horizontal toolbars may scroll when reflow would hide operations.
- Forms use at least 16px input text on narrow iOS layouts.
- No whole-page horizontal overflow at supported responsive widths.

## Overlays and feedback

- Product workflows use app-owned overlays; browser `alert()`, `confirm()` and `prompt()` are not acceptable for final production UI.
- Serious destructive actions use explicit consequence language and the real action verb.
- Focus must move into modal overlays and return to the initiating control on close where the existing architecture permits.
- Toasts/inline banners acknowledge; editable errors remain near the field or action that needs correction.

## Async and resilience

- Mutation UI follows the native server idempotency and lifecycle-concurrency controls.
- Network retries must reuse the same idempotency identity when the same mutation is retried.
- An in-flight action must visibly become busy/disabled when double execution would be harmful.
- Authorization failures and lifecycle conflicts are never disguised as generic network errors.
- Hosted/read-only certification must not trigger business mutations.

## Permission UI

- Navigation and workspace availability follow the employee workspace profile and RBAC authority.
- Controls without authority should be hidden when the feature itself is unavailable; contextual unavailable actions may remain disabled only when the reason improves operator understanding.
- Client-side visibility is convenience, not authorization; server enforcement remains authoritative.

## Migration status

- Current visual direction: Premium Industrial Retail.
- Legacy workspace CSS may remain during migration, but the final loaded Total Tools premium layers own canonical visual output.
- New visual drift back to teal-heavy enterprise styling, blue/purple SaaS themes, excessive pills or glassmorphism is prohibited unless `DESIGN.md` is deliberately revised.

## Verification

Required release-facing checks include:

- `npm run check:production-certification`
- disposable release certification for mutation-heavy runtime proof
- responsive shell certification
- manual desktop/tablet/phone visual acceptance
- keyboard focus inspection on changed controls
- no broken native assets or horizontal page overflow
- no production-data mutation during hosted visual/read-only verification
