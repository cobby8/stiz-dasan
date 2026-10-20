# Monthly invoice workflow

## 1. Establish the billing scope

- Confirm academy branch, target year/month, annual-schedule billing period, and invoice due date.
- For maintained historical periods, read the exact Google Sheet metadata and bounded target-month rows. Do not create or require a new October 2026 Sheet ledger.
- Read current Rallyz invoice candidates for the same branch and month.
- Read the website's active enrollments, pending change requests, billing preview, and prior invoices.

## 2. Normalize the three sources

Create one comparison row per student and class with stable identity, class, status, effective period, tuition, discount, shuttle status/fee, final amount, and identifiers from all three systems.

Name aliases such as `A/B` suffixes or parenthesized Rallyz names must be explicit mappings, never fuzzy guesses.

## 3. Apply exclusions before totals

- Exclude pause, withdrawal, carry-over, and other policy-defined non-billable rows.
- Additional-class rows are excluded from the regular monthly run unless the user explicitly directs otherwise.
- Exclude zero-won invoices.
- If one student has conflicting active and excluded rows, place the student on hold until the intended enrollment is verified.

## 4. Reconcile fees

- Use the site's confirmed period/class amounts for current operations. Use approved Sheet amounts only when reconciling a maintained historical period.
- Validate those amounts against the policy reference and website calculations.
- In Rallyz, represent tuition discounts as discounts and shuttle fees as a separately named `셔틀비` expense.
- Do not bury shuttle fees inside tuition or apply a second discount to an already discounted Sheet amount.

## 5. Pre-issue gate

For the new workbench, first verify original absence, one compensation choice, official scheduled class dates, discount-adjusted source tuition, carry balance allocation, and the saved period/version. Block stale or unsupported evidence instead of substituting a fixed template amount. Site issue, Rallyz reflection, delivery, and payment are separate states.

Block issue unless every Sheet billing row has one intended Rallyz item, every intended invoice has a website record or pending-sync record, missing students and unexplained mismatches are zero, totals match, zero-won invoices are excluded, excluded students are not selected, the annual-schedule period is correct, and notification choice is explicit.

## 6. Issue and notify

- Select only reconciled invoice items and recompute count and total from the checked UI state.
- Show the exact action-time preview and obtain approval.
- Set the annual-schedule period, choose the approved notification option, and issue.
- Verify success and the downstream payment/website ledger.

## 7. Post-issue reconciliation

Record unique students, invoice count, tuition total, shuttle total, grand total, billing period, due date, notification result, exceptions, and verification state of all three systems.

If any system cannot be updated, leave the run incomplete and surface the exact retry action.
