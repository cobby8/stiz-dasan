---
name: stiz-monthly-billing
description: Reconcile and synchronize STIZ monthly enrollment, tuition, discounts, shuttle fees, invoices, and parent change requests across Google Sheets, Rallyz, and stiz-dasan.kr.
---

# STIZ Monthly Billing

Use this skill for monthly tuition review, parent-request processing, enrollment changes, and invoice preparation where Google Sheets, Rallyz, and `stiz-dasan.kr` must remain synchronized.

This repository copy is authoritative for STIZ work in this project. Do not copy a personal-machine version back over it without reviewing the diff and rerunning the repository tests.

## Non-negotiable invariant

Treat the three systems as one connected operating workflow:

- Google Sheets: historical ledger for periods the academy maintained there; do not create a new October 2026 ledger.
- Rallyz: current external enrollment and invoice-delivery channel.
- `stiz-dasan.kr`: integration, validation, audit, and eventual source of truth.

For each approved change, record the intended state in the site and Rallyz and in Sheets only for a maintained historical period. Apply every supported update and report unsupported or failed updates as unresolved. Complete with a reconciliation across the applicable systems or an explicit exception report.

## Choose the operating mode

- For monthly invoice review and issue, read [references/monthly-workflow.md](references/monthly-workflow.md) and [references/billing-policies.md](references/billing-policies.md).
- For pasted parent requests or enrollment changes, read [references/change-request-sync.md](references/change-request-sync.md) and [references/billing-policies.md](references/billing-policies.md).
- For a new student's end-to-end registration, read [references/first-registration.md](references/first-registration.md) before treating the student row as complete.
- For website implementation or automation planning, read [references/integration-roadmap.md](references/integration-roadmap.md).

## Required safeguards

User policy update (2026-09-22): confirmed existing paid-record synchronization during a user-requested operations sync is preauthorized within the scope in the repository AGENTS.md, section '승인 범위의 재사용'. Do not ask again for these existing Sheet/Payment/Invoice corrections. Keep dry-run evidence, stable identity verification, current-value checks, audit history and post-write verification. New invoices, refunds, notifications, enrollment changes and unattended writes remain outside this exception. Ambiguous records remain HELD.

1. Start from the user's requested target month and the correct academy branch.
2. Build a dry-run change ledger before any external mutation. Each row must identify the student, effective month/date, change kind, and expected state in the website and Rallyz, plus Sheets when that period is maintained there.
3. Match students with stable identifiers when available. Do not rely on name alone for duplicates or similar names.
4. Separate automatic actions from `확인보류`. Stop on ambiguous identity, conflicting statuses, unknown class, unexplained fee, missing contact, duplicate invoice, or cross-system mismatch.
5. Before issuing/canceling invoices, sending notifications or invitations, deleting records, or transmitting personal information, show an action-time preview and stop. Identify exact recipients or records, before-and-after values, message or transaction content, and item count. Execute only after explicit approval of that preview.
6. Treat preparation and delivery as separate phases. Keep SMS, Kakao, email, push, Rallyz invoice notifications, and parent invitations `HELD` until the user approves the exact preview. If recipients, wording, values, or counts change, obtain approval again.
7. Do not issue zero-won invoices or invoices for excluded statuses.
8. After writes, re-read the applicable systems and compare counts, students, invoice rows, tuition, shuttle fees, discounts, periods, and totals.
9. Leave an audit result containing applied, skipped, held, and failed items. Never silently treat partial success as completion.
10. Only one operating computer or session with an explicit executor ID may own scheduled external reconciliation. Another computer defaults to read-only and dry-run until the handoff record names it `ACTIVE`. If the executor ID or previous-runner pause evidence is unknown, unattended external writes remain disabled.

## First-time student registration completion

For a genuinely new student, registration is not complete merely because the student and class rows exist. Reconcile the site and Rallyz identity, class and actual start date, prior paid period, next billable period, invoice and notification, and parent invitation. Use Sheets only for periods where the academy still maintains a Sheet ledger; the user stopped creating the October 2026 Sheet ledger. Mid-month starts use confirmed remaining class sessions. Include shuttle only when requested and valid for the class day. See [references/first-registration.md](references/first-registration.md).

This is a required outcome, not blanket execution permission. Keep the invoice, invoice notification, and Rallyz parent invitation `HELD` until the user's current request or an action-time preview authorizes the specific student, branch, class, period, amount, masked recipient, delivery method, and item count. Do not seek repeat approval for an already authorized unchanged action. Re-read the applicable systems, invoice state, and parent connection after execution.

## Transition policy

The user designated `stiz-dasan.kr` as the operating source of truth and stopped creating the October 2026 Sheet ledger. Reconcile historical Sheet periods when relevant, but do not create a new Sheet month as a prerequisite for registration or billing. Rallyz remains the external enrollment/invoice channel until its functions are actually migrated and verified.
