# Total Tools POS AI Agent Instructions

These instructions are mandatory for any AI coding agent working in this repository.

## Required first step

Before any substantial work, **read and obey [`AI_EXECUTION_CONTRACT.md`](./AI_EXECUTION_CONTRACT.md)**.

Treat it as an execution gate, not optional guidance. In addition:

- Verify the authoritative branch/PR/HEAD before modifying code.
- Preserve the current working product and avoid unrelated rewrites.
- Prioritize money, inventory, credential/security, commercial-account, repair, rental, and fulfillment correctness over feature breadth.
- Treat checkout, returns, refunds, reservations, receiving, transfers, commercial approvals, work-order state, rental custody, and financial postings as hard invariants.
- Validate server-side permissions; do not rely on hidden UI controls.
- Use database-enforced guarantees for business invariants where appropriate.
- Benchmark substantial UX/design work against current strong POS, retail, service, repair, inventory, and procurement systems.
- Prefer complete role-specific workflows for cashier, salesperson, warehouse, technician, purchasing, manager, and administrator over one generic interface.
- Do not add paid infrastructure without build-vs-buy justification.
- Before saying "done", run the adversarial completion checks required by the execution contract.

When project-specific documentation and the execution contract differ, follow the stricter safety, correctness, verification, and release requirement.
