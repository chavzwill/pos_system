# TT AI v0.1 architecture

## Principle

TT AI is an intelligence and orchestration layer, not a new source of truth.

```text
Employee
  -> authenticated Total Tools staff boundary
  -> TT AI
       -> policy + permission gate
       -> read-only tool registry
       -> product/equipment knowledge
       -> evidence collector
       -> model synthesis (future)
            -> POS read adapter
            -> SpendOS read adapter
            -> SmartCommerce read adapter
            -> manufacturer/internal document retrieval
  -> answer with fact classification + evidence
```

## Required fact labels

Every operational or technical response must resolve to one of:

- verified: directly supported by authoritative evidence;
- calculated: deterministic calculation over cited evidence;
- inferred: reasoning/recommendation over cited evidence;
- unknown: insufficient evidence.

## POS security boundary

The actual POS master was verified to include server-side sessions, API-key scopes, bcrypt credential handling and server-side RBAC. The older CLAUDE.md security description is stale.

TT AI does **not** use an integration API key as employee identity. The branch mounts a staff-session-only gateway at /api/tt-ai that:

1. rejects machine API-key identity;
2. binds requests to the authenticated POS employee;
3. enforces branch access and existing permissions;
4. withholds sensitive cost fields unless the employee has purchasing or financial-report authority;
5. exposes only read operations.

When TT AI becomes a separate service, the POS server should exchange the staff session for a short-lived audience-bound assertion rather than forwarding cookies or trusting browser-supplied identity headers.

## Model provider

No model provider is selected in v0.1. The orchestration contract is deliberately provider-neutral so the company can later choose:
- a hosted model;
- a locally hosted model;
- a hybrid router.

A model may generate language and plans, but it may never become the authority for company data, stock, prices, compatibility, financial state or approvals.

## Next build slice

1. add manufacturer/internal-document ingestion and evidence extraction;
2. connect the staff-session gateway to TT AI retrieval orchestration;
3. map existing rental/work-order asset identifiers into machine model and asset records;
4. import a small real non-production product/manual set and validate compatibility retrieval;
5. add the first Ask TT AI staff UI after retrieval is evidence-correct;
6. keep all write actions disabled until separately reviewed.
