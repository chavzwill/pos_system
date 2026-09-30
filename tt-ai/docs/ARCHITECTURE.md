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

## Security gate before POS connection

The reviewed POS documentation still describes a legacy frontend-only permission model on the canonical branch documentation. TT AI must **not** connect directly to unrestricted POS routes.

Before enabling the POS adapter:

1. verify server-side staff authentication/session enforcement on the actual release branch;
2. verify endpoint-level RBAC for every route exposed to TT AI;
3. issue a server-to-server TT AI credential that cannot impersonate arbitrary employees;
4. bind every AI request to an authenticated employee ID, branch and resolved permissions;
5. prevent TT AI headers from becoming trusted identity assertions by themselves;
6. log user, tool, source record, purpose and outcome;
7. keep write tools disabled until separately reviewed.

## Model provider

No model provider is selected in v0.1. The orchestration contract is deliberately provider-neutral so the company can later choose:
- a hosted model;
- a locally hosted model;
- a hybrid router.

A model may generate language and plans, but it may never become the authority for company data, stock, prices, compatibility, financial state or approvals.

## Next build slice

1. verify hardened POS staff-auth branch against master;
2. define authenticated read gateway endpoints for TT AI;
3. add manufacturer/internal-document ingestion metadata;
4. add product/model/part compatibility storage;
5. implement retrieval tests using real non-production records;
6. add the first staff UI only after the auth boundary is proven.
