# Total Tools POS Design System

## Product character

Total Tools POS is an operational retail, rental, repair, inventory, purchasing, dispatch, CRM, and finance system for employees working under time pressure. The interface should feel premium, trustworthy, fast, and unmistakably Total Tools: industrial rather than corporate-generic; friendly rather than playful; dense enough for operators without looking legacy.

## Visual direction

**Direction:** Premium Industrial Retail.

The visual world combines clean modern commerce UI with Total Tools brand cues taken from the company identity: vivid green, safety yellow, white, charcoal, and restrained warm neutrals. The interface should evoke a well-run premium tool showroom and service counter: bright product surfaces, dark structural rails, high-visibility action accents, and precise operational hierarchy.

Avoid teal-heavy enterprise styling, blue/purple SaaS gradients, glassmorphism, excessive pills, decorative card mosaics, and generic dashboard chrome.

## Core palette

- `brand-green`: `#087A3B` — primary Total Tools action and brand color
- `brand-green-strong`: `#05632F` — hover/pressed and high-emphasis brand surfaces
- `brand-green-deep`: `#073D25` — navigation rail, premium dark accents
- `brand-yellow`: `#F3C51D` — safety/attention accent and Total Tools signature highlight
- `brand-yellow-soft`: `#FFF6C9` — restrained highlighted surface
- `ink`: `#16211B` — primary text
- `muted`: `#65716A` — secondary text
- `canvas`: `#F3F5F1` — application background
- `surface`: `#FFFFFF` — primary working surfaces
- `surface-soft`: `#F8FAF7` — secondary containers
- `line`: `#DCE3DD` — borders/dividers
- `line-strong`: `#C8D3CB` — strong separators
- `danger`: `#B9382F`
- `warning`: `#A46600`
- `info`: `#286F90`
- `success`: `#087A3B`

Green is the action color. Yellow is a signature accent, not a second primary button color. Red is reserved for destructive/error states.

## Typography

Use a high-quality system stack to avoid runtime font dependency:

`ui-sans-serif, "Segoe UI Variable", "Segoe UI", Inter, Arial, sans-serif`

Roles:

- Workspace title: 28–42px, 800–850, tight tracking
- Section heading: 16–20px, 760–800
- Card/product title: 13–16px, 700–760
- Body: 12–14px, 450–550
- Utility/metadata: 10–12px, 650–750
- Numeric totals: tabular numerals, 700–850

Do not make the UI look premium by making all text tiny. Dense surfaces may reduce metadata, but primary task text stays readable.

## Layout

### App shell

- Desktop rail: 236–252px, deep green/charcoal structure
- Sticky top bar: white, restrained border, 64–68px
- Content canvas: broad, low-noise, max width only where scanning benefits
- Dashboard/home: editorial hero + compact operational metrics + grouped module cards
- Mobile: sidebar becomes a proper drawer; cards and work surfaces recompose rather than simply shrink

### POS / sales

The Point of Sale surface should resemble a premium retail checkout system:

- Catalog/search is the dominant left surface
- Cart/checkout is a distinct right-side decision rail
- Product tiles feel like merchandise cards, not admin cards
- Price uses brand green; stock/availability is secondary
- Cart totals have a strong final-payment hierarchy
- Checkout is the single dominant action in the cart region

### Operational workspaces

Inventory, purchasing, repairs, rentals, dispatch, finance, CRM, and admin retain their domain-specific layouts but share the same surface, border, radius, action, focus, and typography system.

## Component language

- Primary buttons: brand green, 10–12px radius, no heavy shadow
- Secondary buttons: white/soft surface with neutral border
- Danger: red only when genuinely destructive
- Focus: high-contrast yellow-green ring with visible offset
- Cards: 14–18px radius on modern operating surfaces; avoid excessive elevation
- Product cards: 14–16px radius with strong hover/focus affordance
- Tables: white, sticky headers where useful, green selected state, no zebra-striping unless density requires it
- Inputs: 10–12px radius, strong focus, stable height
- Status chips: compact, semantic, never color-only
- Scrollbars: visible and subtle across owned scroll surfaces

## Signature element

The recurring Total Tools signature is a **safety-yellow keyline** paired with deep Total Tools green: a narrow yellow top rule, active indicator, or focal divider used at decisive operational moments (checkout, workspace headers, guided mode, high-priority handoff). It should be repeated consistently but sparingly.

## Motion

- 120–180ms for hover/press/focus transitions
- 180–240ms for panels/drawers
- No bounce or decorative ambient motion
- Reduced-motion disables non-essential transitions

## Accessibility and resilience

- WCAG 2.2 AA target
- Visible keyboard focus on every interactive element
- Minimum 16px form text on narrow iOS layouts
- No state communicated by color alone
- Preserve 200% zoom and long labels
- Avoid hidden scrollbars and clipped controls
- Buttons remain stable in size during loading
- User-facing errors must provide a recovery action where possible

## Content voice

Direct, operational, and specific. Prefer `Receive purchase order`, `Complete rental return`, `Open work order`, and `Take payment` over generic verbs such as `Continue` or `Submit`.

## Design ownership

`DESIGN.md` defines durable visual intent. Runtime values should flow through the shared Total Tools CSS token layer rather than being copied independently across workspace styles. New workspace-specific styling should extend these semantic roles instead of inventing a new palette.