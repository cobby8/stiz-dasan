# STIZ integration roadmap

## Current transition state

The user designated `stiz-dasan.kr` as the operating source of truth and stopped creating the October 2026 Sheet ledger. Google Sheets is a historical source only for maintained periods. Rallyz remains the external enrollment and invoice-delivery channel until migration is verified. Do not require a new Sheet month or treat a site record as proof of external issuance or delivery.

## Target workflow

- Parent or staff requests enter one structured website audit ledger.
- The system resolves stable student identity and produces a three-system dry-run.
- An operator reviews ambiguous facts and approves the exact change set.
- Supported adapters apply website and Rallyz changes idempotently, and Sheet changes only for maintained historical periods.
- Billing and notifications remain separate approval-gated actions.
- Post-write reconciliation proves the final state or records an explicit partial failure.

## Scheduler ownership

- Use one `ACTIVE` operating computer or session for the daily scheduled reconciliation.
- Other computers may inspect and prepare dry-runs, but must remain `PAUSED` for external writes.
- During handoff, pause the old scheduler, record the final run and pending ledger, validate the new computer read-only, then activate only the new scheduler.
- Do not create a second Vercel cron or heartbeat for the same responsibility.

## Implementation priorities

1. Stable cross-system identifiers and explicit aliases.
2. One audit ledger with per-target status and idempotency keys.
3. Read adapters and discrepancy reporting for all three systems.
4. Safe write adapters with post-write verification.
5. Approval-gated invoice, invitation, and notification delivery.
6. A durable automation-run lease before enabling unattended writes.

Until a durable run lease exists, treat scheduler ownership as an operational lock and never run the same external mutation workflow on two computers at once.
