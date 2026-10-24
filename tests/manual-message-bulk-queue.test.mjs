import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("bulk manual messages are queued with a 500 recipient cap", async () => {
  const [service, action] = await Promise.all([
    read("src/lib/manual-message-service.ts"),
    read("src/app/actions/admin.ts"),
  ]);
  assert.match(service, /BULK_MANUAL_MESSAGE_RECIPIENT_LIMIT = 500/);
  assert.match(action, /export async function enqueueManualSmsBatch/);
  assert.match(action, /reserveManualMessageQueue/);
});

test("queue claims are concurrency-safe and stale sends become uncertain", async () => {
  const ledger = await read("src/lib/message-ledger.ts");
  assert.match(ledger, /pg_advisory_xact_lock/);
  assert.match(ledger, /FOR UPDATE SKIP LOCKED/);
  assert.match(ledger, /status='UNCERTAIN'/);
  assert.match(ledger, /STALE_SENDING_UNCERTAIN/);
  assert.match(ledger, /STALE_SENDING_UNCERTAIN[^`]*"payloadJSON"=NULL/);
});

test("a corrupt encrypted row is isolated without blocking valid claimed rows", async () => {
  const ledger = await read("src/lib/message-ledger.ts");
  assert.match(ledger, /for \(const row of rows\)/);
  assert.match(ledger, /QUEUE_PAYLOAD_DECRYPT_FAILED/);
  assert.match(ledger, /QUEUE_PAYLOAD_DECRYPT_FAILED[^`]+"payloadJSON"=NULL/);
  assert.match(ledger, /STALE_SENDING_UNCERTAIN[^`]*RETURNING "batchId"/);
  assert.match(ledger, /finalizeBatchIds\.add\(row\.batchId\)/);
  assert.match(ledger, /return \{ items: claimed, finalizeBatchIds:/);
});

test("queued phone and body are encrypted and status output is masked", async () => {
  const ledger = await read("src/lib/message-ledger.ts");
  assert.match(ledger, /aes-256-gcm/);
  assert.match(ledger, /recipientPhoneLast4/);
  assert.match(ledger, /`\*\*\*-\*\*\*\*-\$\{r\.recipientPhoneLast4\}`/);
});

test("cron requires its secret and processes only claimed queue rows", async () => {
  const route = await read("src/app/api/cron/manual-message-dispatch/route.ts");
  assert.match(route, /CRON_SECRET/);
  assert.match(route, /MAX_DISPATCH_PER_RUN = 500/);
  assert.match(route, /claimManualMessageQueue\(MAX_DISPATCH_PER_RUN\)/);
  assert.match(route, /new Set\(claim\.finalizeBatchIds\)/);
  assert.match(route, /sendSmsBulkDetailed/);
  assert.match(route, /markManualMessageAccepted/);
  assert.match(route, /markManualMessageUncertain/);
});

test("accepted Solapi messages wait for final provider reconciliation", async () => {
  const [ledger, reconcile, vercel] = await Promise.all([
    read("src/lib/message-ledger.ts"),
    read("src/app/api/cron/manual-message-reconcile/route.ts"),
    read("vercel.json"),
  ]);
  assert.match(ledger, /"providerStatus"='ACCEPTED'/);
  assert.match(ledger, /COALESCE\("providerStatus",''\) <> 'ACCEPTED'/);
  assert.match(ledger, /getPendingManualSolapiGroups/);
  assert.match(ledger, /providerStatus: r\.providerStatus/);
  assert.match(reconcile, /CRON_SECRET/);
  assert.match(reconcile, /MAX_GROUPS_PER_RUN = 5/);
  assert.match(reconcile, /MISSING_RESULT_GRACE_MS = 10 \* 60 \* 1000/);
  assert.match(reconcile, /SOLAPI_RESULT_MISSING_AFTER_GRACE/);
  assert.match(reconcile, /getSolapiBatchResults/);
  assert.match(reconcile, /finalizeManualSolapiResult/);
  assert.match(vercel, /manual-message-reconcile/);
});
