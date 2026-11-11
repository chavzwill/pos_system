# Commercial white-label POS foundation

This branch is an **isolated commercial product candidate**, based on the operational POS source. It is not a production-certified multi-tenant SaaS product, and must not be merged into Total Tools production without a separate release review.

## Delivery model: one independent installation per buyer

For the first sale, deploy a separate code repository, project, URL, database, secrets and media storage scope for each business. The POS database and authorization model are still **single-company**. Do not host multiple unrelated businesses in one shared database or assume that setting a different logo provides tenant isolation.

Never copy production databases, uploads, employee/customer records, API keys, payment credentials or Total Tools business configuration into a buyer's installation. Provision a fresh database, new administrator credentials and independent integration connections. In production, configure a **unique POS_INSTANCE_ID** using lowercase letters/numbers/hyphens (3–51 chars) so the company-logo upload receives a separate Cloudinary namespace. Separate Cloudinary accounts are preferable if customers require independent asset ownership and offboarding.

## Brand customization

An authorized company settings administrator opens **Administration → System Configuration → Branding & appearance**. The administrator can:
- Upload or remove a company logo (JPEG, PNG or WebP; validated size up to 5 MB).
- Set the business name, primary and secondary colours, accent colour, default mode and font.
- Preview colours in the editor and save company-level settings.

The installed app reads the public, allowlisted brand settings, updates the login, navigation, browser title/favicon, app manifest and supported document print headers. Receipt and report print views consume the current brand. Existing document templates and integrations beyond those covered here still need a complete inventory and release check before sale.

Each employee also has **My appearance** in navigation. The user-specific display mode, density and interface accent are stored on the server by their authenticated employee ID; individual appearance changes do not change business identity, document colours or other employees' saved settings.

## Configuration / acceptance gates

1. Create a private buyer repository from this branch or a verified export, with **no Git history if it contains sensitive company-specific history**.
2. Create a fresh database, storage scope, deployment project and unique customer URL. Set `POS_INSTANCE_ID` for production.
3. Run secure administrator initialization and credential preflight, never a demo admin.
4. Set the brand in settings, upload a sample logo and verify the login, global navigation, favicon, PWA installation, sales receipt and reports. Validate that user appearance choices are distinct across two employee accounts and survive cross-device sign-in.
5. Review all quotation, PR, PO, receiving, supplier invoice, dispatch, rental, repair and accounting print/export workflows for old company identity and apply the shared brand where appropriate.
6. Remove or reconfigure Total Tools-only integrations (SmartCommerce, WooCommerce, TT AI, branch identifiers, tax/business defaults). Revalidate access control and run isolated business data tests.
7. Verify transactional accuracy, payment reconciliation, backups and restores, security policies, accessibility, responsive UI and host-specific storage durability. The original POS release gate remains required before commercial go-live.
8. Do not enable Vercel automatic previews or deploy to the existing Total Tools project. Batch and test changes locally to limit spend.

## Limitations

- This is not a license server, subscription platform, reseller billing system, customer self-signup portal, or cross-tenant admin console.
- Browser PWA icon compatibility varies by image shape and MIME type. Provide a square PNG for best results; the manifest also retains generic fallback icons.
- Some legacy UI copy and older print/export paths remain company-specific. These must be removed or adapted before an unrestricted commercial release.
- Changes made on this development branch do **not** change the hosted Total Tools POS.
