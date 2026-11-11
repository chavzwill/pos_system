# White-Label Commercial POS

A customizable business point-of-sale and operations platform derived from the existing operational POS codebase. Designed for **separate, independently configured business installations**.

## Features

The underlying platform includes sales, held orders, inventory, purchasing, purchase requests and approvals, receiving, supplier invoices, warehouse transfers, rentals, repairs, dispatch, customer management, and reporting. Workflows must be acceptance-tested for each customer's deployment.

The white-label layer adds:

- Company name, logo upload/removal, primary/secondary/accent colours, typography and default appearance
- Live appearance preview in Administration → System Configuration → Branding & appearance
- Company identity on the main application shell, login, browser/app title, PWA manifest, supported receipts and printable report/dispatch outputs
- Employee-specific UI preferences saved by staff account, separate from company branding
- Company-authorized configuration changes with validation and existing security auditing

## Isolated customer deployment

**Never connect a buyer's POS to the Total Tools production database, uploads or integrations.** Create a fresh database and independent secrets, file storage, brand, URL and release project. Never export an existing business's customer, employee, supplier, inventory, sales or invoice records.

The underlying application remains single-company. The commercial edition uses **one installation per customer**. It is **not** yet a shared-database multi-tenant SaaS.

For production logo storage, set a distinct `POS_INSTANCE_ID` for each installation and configure durable media storage. Use a fresh administrator provisioned with real secret credentials, not a demo login.

See `docs/WHITE_LABEL_COMMERCIAL_EDITION.md` for setup steps, security boundaries and release gates.

## Development and validation

Install dependencies with `npm ci`. Review the environment-variable examples, initialize a **new** local database and staff credentials following the production credential-preflight instructions, then run `npm start`.

Selected quality checks:

```sh
node --test tests/white-label-branding.test.js
npm run check:client-syntax
npm run check:unified-ui
```

This code is a **commercialization foundation**, not a guarantee of full production certification. Remaining company-specific templates and integration references must be reviewed and removed or parameterized before delivery to a paying customer. Do not deploy over the Total Tools POS environment.
