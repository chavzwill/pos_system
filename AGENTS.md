# Repository-first engineering standard

Owner directive, 2026-11-26. Apply to substantial features, refactors and model training; preserve stricter existing project instructions.

1. Inspect the current implementation and diagnose the actual failure before changing it. Establish a reproducible baseline.
2. Search existing repositories and established libraries first. Read the relevant source, tests, dependency constraints and maintenance history. Compare at least two credible implementations where practical. Record upstream URL, pinned commit/version, source paths, evidence, trade-offs and decision (reuse, adapt, independently implement, or reject). Do not cite a README as proof of performance.
3. Prefer existing proven components and independently implemented techniques over rebuilding or repeated model fitting. Reuse source only where permission permits; retain required notices and do not copy incompatible proprietary code. No license purchases, paid APIs, subscriptions or new paid infrastructure without explicit owner approval. Do not send private code, credentials, business or customer data to external services.
4. Isolate changes in a branch, preserve existing behavior and checkpoints, test the existing baseline against the candidate under realistic workloads, and document regressions and resource usage. Do not replace functioning components solely because another repository claims a feature. Keep dependency changes small, pinned and auditable.
5. For AI training, diagnose knowledge vs reasoning vs pipeline faults, require relevant quality data and independent grouped evaluation, stop on unacceptable regression or no gain, and retain existing checkpoints. Current PocketCompute GPU/TPU hold remains in effect; no paid compute. Training results must distinguish screening from release qualification.
6. Document blockers, unverified behavior and exactly what was tested. Never claim integration, training, deployment or commercial readiness without evidence. No automatic production deployment or destructive changes from a research branch.

## Project-specific priority

Prioritize proven inventory, purchase, receiving, dispatch, rental and repair patterns; preserve transactional integrity, authorization and cost controls.
