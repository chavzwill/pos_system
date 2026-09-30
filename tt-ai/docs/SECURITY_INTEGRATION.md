# TT AI security integration

## Verified POS master state

Reviewed against POS `master` at commit `8082680d5efddd006df68d2453a9fd3d115c6ff5`.

The current server code includes:
- server-side session authentication;
- bcrypt password/PIN support and credential lifecycle controls;
- API-key hashing, explicit scopes and rate limiting;
- server-side permission checks;
- security auditing;
- same-origin mutation protection and security headers.

The older `CLAUDE.md` description of frontend-only authentication is stale and must not be used as the security source of truth.

## Why TT AI does not use a normal POS API key for staff requests

POS API keys are integration credentials. Approved scoped routes intentionally bypass employee permission middleware after scope validation.

That is correct for machine integrations, but it means a TT AI request cannot claim it "inherits the employee's permissions" merely because TT AI holds a POS API key.

Therefore the employee-facing TT AI path is:

```text
employee browser
  -> authenticated POS staff session
  -> /api/tt-ai/*
  -> POS server resolves employee + branch + permissions
  -> approved read gateway
  -> TT AI evidence/orchestration layer
```

The new TT AI gateway:
- rejects machine API-key identity;
- requires the existing staff session;
- checks approved role permissions;
- defaults operational reads to the employee's branch;
- blocks cross-branch reads without `multi_branch_access`;
- withholds product cost unless Purchasing or Financial Reporting authority is present;
- exposes no write operation.

## Future split into a separate TT AI service

When TT AI moves out of the POS process, do not forward browser cookies to the AI service.

Use a short-lived, audience-bound server assertion created by the POS backend containing only:
- employee ID;
- branch ID;
- resolved capability set;
- request/correlation ID;
- issued/expiry time;
- nonce.

The TT AI service must validate the assertion and still enforce its own tool policy. It must not accept arbitrary employee/permission headers from browsers.
