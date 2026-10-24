# Parent and enrollment change synchronization

## Intake and interpretation

- Preserve the parent's original wording in the audit source while storing a separate structured interpretation.
- Resolve the student with stable identity evidence and establish the effective date or month.
- Translate the request into explicit changes such as pause, withdrawal, resume, class add/change, shuttle start/stop, contact correction, or billing correction.
- Ask for clarification when the student, class, date, route, fee, or requested outcome remains ambiguous.

## Dry-run ledger

For each intended change record stable student identity, effective date/month, change kind, current and expected Sheet/Rallyz/website state, prerequisites, billing effect, notification effect, and idempotency key.

Classify each target as `READY`, `HELD`, `APPLIED`, `SKIPPED`, or `FAILED`. A website-only change is not complete when Sheet or Rallyz remains pending.

## Apply and verify

1. Create or update the website audit record without claiming success.
2. Update the matched Sheet rows and re-read them.
3. Apply the matching Rallyz status/class change and re-read it.
4. Mark the website operation complete only after the expected three-system state is verified.

Rallyz has no confirmed official write API, so use a logged-in supervised browser flow. Do not infer success from a click; inspect the resulting state.

## Shuttle coupling for status changes

- Pause and withdrawal are not limited to class rows. When a student becomes paused or withdrawn for a target month, remove that month and later regular shuttle assignments from the website shuttle ledger unless the user explicitly preserves a historical snapshot.
- Never import or reconcile a regular shuttle month from the vehicle sheet alone. Always join the target-month enrollment/status ledger first; vehicle-sheet rows for paused or withdrawn students are stale candidates and must be excluded from the website driver/admin route views.
- Resume should use the student's last valid pre-pause shuttle assignment as a restoration candidate, not as an automatic final state.
- If the resumed class day/time, shuttle route, stop name, pickup/dropoff time, free-shuttle eligibility, or vehicle sheet route changed while the student was paused, keep the shuttle restoration `HELD` and ask the administrator to adjust it.
- If only the status changed and the class/route/time still matches the latest vehicle sheet and website route map, restore the previous shuttle assignment idempotently and verify Sheet/Rallyz/website after the change.

## Billing and notification boundary

- Enrollment approval does not automatically authorize invoice creation, cancellation, payment/refund, SMS, Kakao, push, or invitation delivery.
- A genuinely new student's first registration must include a first invoice and its parent notification, followed by a Rallyz parent invitation after the Rallyz student record is verified. These items are required completion steps but remain separate `HELD` actions until the exact execution preview is approved.
- For a mid-month start, calculate the first invoice from the remaining confirmed class sessions. Do not treat a new student as a full-month charge without checking the start date and annual schedule.
- Prepare exact affected invoices and message recipients, then keep them `HELD` until the user approves the action-time preview.
- Parent invitations are an external notification. Confirm the exact student, masked contact, academy branch, method, and count immediately before sending.
- Recheck active status, duplicates, contact validity, and existing parent connection immediately before sending.
- After delivery, re-read the invoice, notification ledger, Rallyz parent connection, and the student/class state in all three systems before marking registration complete.

## Failure and replay

- Reuse stable idempotency keys so retries do not duplicate changes.
- On partial failure, retry only pending or failed targets after re-reading current state.
- If the same key now describes a different amount, period, recipient, class, or message, invalidate prior approval and place the operation on hold.
